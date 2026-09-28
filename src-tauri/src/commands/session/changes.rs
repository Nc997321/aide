// 会话变更落盘域：变更面板每轮 captureChanges 的 append（O(1) 追加）与
// revert 场景的全量 save / load。文件 `~/.aide/sessions/<id>-changes.json`
// （JSONL，兼容旧 pretty 数组）。

use std::fs;

use crate::commands::{our_sessions_dir, ChangeRoundData};

/// 每轮 Claude 回完都会调用一次（`useConversationChanges.captureChanges → save`），
/// 把累积的全部 `rounds` 序列化落盘。同步版是 2026-07-08 第二次真实冻结的根因：
/// `serde_json::to_string_pretty(&rounds)`（随会话变长，CPU 满核序列化）+ `fs::write`
/// （杀软实时扫描/磁盘争抢时可拖到 27s）两段式堵死 Tauri 主线程，报告实锤 `pending`
/// 单调涨 + `aide.exe` 首帧 100% CPU。和 `session_jsonl_size` 同一类反模式（见
/// CLAUDE.md「同步 command 禁止重 IO」），一并改 async + spawn_blocking。
#[tauri::command]
pub async fn load_session_changes(session_id: String) -> Result<Vec<ChangeRoundData>, String> {
    tokio::task::spawn_blocking(move || load_session_changes_blocking(session_id))
        .await
        .map_err(|e| format!("load_session_changes task panicked: {}", e))?
}

/// changes 文件格式（2026-08-26 起）：
/// - 全量覆盖（save_session_changes）写 JSONL：每行一个 round 的 compact JSON + 末尾换行。
///   比旧 `to_string_pretty` 省序列化 CPU（compact 单行 vs pretty 多行）+ 与 append 格式统一。
/// - 追加（append_session_change）在文件尾 append 一行，O(1) 落盘——每轮 captureChanges
///   不再整份 rounds 重序列化重写（§10.1 顺手优化：把 save_session_changes 每轮 O(总轮数)
///   降为 O(1)）。
/// - 读取兼容旧 pretty 数组：文件以 '[' 开头 → 旧格式整读 from_str；否则 JSONL 逐行 parse。
fn load_session_changes_blocking(session_id: String) -> Result<Vec<ChangeRoundData>, String> {
    let path = our_sessions_dir().join(format!("{}-changes.json", session_id));
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read changes: {}", e))?;
    let trimmed = content.trim_start();
    if trimmed.starts_with('[') {
        // 旧版 pretty 数组格式（2026-08-26 之前）
        return serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse changes: {}", e));
    }
    let mut rounds = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let round: ChangeRoundData = serde_json::from_str(line)
            .map_err(|e| format!("Failed to parse changes line {}: {}", i + 1, e))?;
        rounds.push(round);
    }
    Ok(rounds)
}

#[tauri::command]
pub async fn save_session_changes(
    session_id: String,
    rounds: Vec<ChangeRoundData>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_session_changes_blocking(session_id, rounds))
        .await
        .map_err(|e| format!("save_session_changes task panicked: {}", e))?
}

/// 全量覆盖落盘（revertRound / revertSingleFile 等轮次变少/修改场景）：JSONL 每行一轮。
fn save_session_changes_blocking(
    session_id: String,
    rounds: Vec<ChangeRoundData>,
) -> Result<(), String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let path = dir.join(format!("{}-changes.json", session_id));
    let mut content = String::new();
    for r in &rounds {
        content.push_str(
            &serde_json::to_string(r).map_err(|e| format!("Failed to serialize: {}", e))?,
        );
        content.push('\n');
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write: {}", e))
}

/// 追加单轮（captureChanges 的常规路径）：O(1) append 一行，不重写整份文件。
/// 前端用磁盘尾轮锚点保证只追加「磁盘之后的新轮」；revert 场景改走全量 save。
#[tauri::command]
pub async fn append_session_change(
    session_id: String,
    round: ChangeRoundData,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || append_session_change_blocking(session_id, round))
        .await
        .map_err(|e| format!("append_session_change task panicked: {}", e))?
}

fn append_session_change_blocking(
    session_id: String,
    round: ChangeRoundData,
) -> Result<(), String> {
    let dir = our_sessions_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    let path = dir.join(format!("{}-changes.json", session_id));
    let line = serde_json::to_string(&round).map_err(|e| format!("Failed to serialize: {}", e))?;
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open changes: {}", e))?;
    writeln!(file, "{line}").map_err(|e| format!("Failed to append: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ChangeFileData;

    // ── changes 落盘：append（JSONL 追加）/ save（全量覆盖）/ load（双格式兼容）──

    fn change_round(index: u32) -> ChangeRoundData {
        ChangeRoundData {
            index,
            time: format!("12:0{index}"),
            files: vec![ChangeFileData {
                path: format!("src/a{index}.ts"),
                status: "M".to_string(),
                additions: 1,
                deletions: 0,
            }],
            rewind_to: Some(100 + index as u64),
            prompt: Some(format!("提问 {index}")),
            base_rev: None,
        }
    }

    fn changes_path(id: &str) -> std::path::PathBuf {
        our_sessions_dir().join(format!("{id}-changes.json"))
    }

    #[test]
    fn changes_append_then_load_round_trips() {
        // append 两次 → load 回读两轮、顺序正确（JSONL 路径：exists 真 + starts_with 假 + 非空行）
        let id = format!("test-changes-append-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);

        append_session_change_blocking(id.clone(), change_round(1)).unwrap();
        append_session_change_blocking(id.clone(), change_round(2)).unwrap();

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds.len(), 2);
        assert_eq!(rounds[0].index, 1);
        assert_eq!(rounds[0].prompt.as_deref(), Some("提问 1"));
        assert_eq!(rounds[1].index, 2);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_save_full_overwrite_then_load() {
        // 全量覆盖语义（revert 场景）：save 两轮 → load 两轮；再 save 单轮 → load 只剩该轮
        let id = format!("test-changes-save-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);

        save_session_changes_blocking(id.clone(), vec![change_round(1), change_round(2)]).unwrap();
        assert_eq!(load_session_changes_blocking(id.clone()).unwrap().len(), 2);

        save_session_changes_blocking(id.clone(), vec![change_round(3)]).unwrap();
        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].index, 3);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_load_accepts_legacy_pretty_array() {
        // 2026-08-26 前的 pretty 数组格式仍能读（starts_with '[' 真分支）
        let id = format!("test-changes-legacy-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);
        fs::create_dir_all(our_sessions_dir()).unwrap();
        fs::write(
            &path,
            serde_json::to_string_pretty(&vec![change_round(1), change_round(2)]).unwrap(),
        )
        .unwrap();

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds.len(), 2);
        assert_eq!(rounds[1].rewind_to, Some(102));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_load_missing_file_returns_empty() {
        // 会话无变更文件（exists 假分支）→ 空 Vec，不是错误
        let id = format!("test-changes-missing-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert!(rounds.is_empty());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_load_skips_blank_lines() {
        // JSONL 中间出现空行（截断/手编残留）→ 跳过，不误判为损坏（空行真分支）
        let id = format!("test-changes-blank-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);
        fs::create_dir_all(our_sessions_dir()).unwrap();
        let mut content = serde_json::to_string(&change_round(1)).unwrap();
        content.push_str("\n\n");
        content.push_str(&serde_json::to_string(&change_round(2)).unwrap());
        content.push('\n');
        fs::write(&path, content).unwrap();

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds.len(), 2);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_load_rejects_invalid_line() {
        // JSONL 行非 JSON → Err（parse 错误臂）：损坏文件宁可报错也不静默丢数据
        let id = format!("test-changes-corrupt-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);
        fs::create_dir_all(our_sessions_dir()).unwrap();
        fs::write(&path, "not json\n").unwrap();

        assert!(load_session_changes_blocking(id.clone()).is_err());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_load_rejects_corrupt_legacy_array() {
        // 旧 pretty 数组格式损坏 → Err（starts_with '[' 分支的 from_str 错误臂）
        let id = format!("test-changes-corrupt-legacy-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);
        fs::create_dir_all(our_sessions_dir()).unwrap();
        fs::write(&path, "[{\"index\": 1, broken").unwrap();

        assert!(load_session_changes_blocking(id.clone()).is_err());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_serializes_base_rev_under_the_camel_case_key() {
        // 跨 IPC 的**字段名**契约：Tauri 只转换命令的**参数名**（camelCase → snake_case），
        // 嵌套 struct 的字段名走 serde 原样 —— `rename_all = "camelCase"` 是这条契约的实现。
        // 写歪一个字母字段就**静默消失**（`rewind_to` 当年就是这么丢的，见隔壁两条用例）。
        let mut r = change_round(1);
        r.base_rev = Some("b".repeat(40));
        let json = serde_json::to_string(&r).unwrap();
        assert!(
            json.contains("\"baseRev\":\"bbbb"),
            "wire key 必须是 baseRev：{}",
            json
        );
    }

    #[test]
    fn changes_serializes_rewind_to_under_the_camel_case_key() {
        // 与 TS 侧 `ChangeRound.rewindTo` 逐字一致。原先本 struct 没有 rename_all → 序列化出的是
        // `rewind_to`：写盘被 TS 的 `rewindTo` 忽略（存 null）、读回时 TS 读不到（恒 undefined）。
        let json = serde_json::to_string(&change_round(1)).unwrap();
        assert!(
            json.contains("\"rewindTo\":101"),
            "wire key 必须是 rewindTo：{}",
            json
        );
    }

    #[test]
    fn changes_load_accepts_legacy_snake_case_rewind_to() {
        // 2026-09-28 之前落盘写的是 `rewind_to`（snake）——线上名改 camelCase 后靠 alias 照读，
        // 否则老会话的回退锚点全丢（历史轮不再能「撤回到此处」）。
        let id = format!("test-changes-legacy-rewind-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);
        fs::create_dir_all(our_sessions_dir()).unwrap();
        fs::write(
            &path,
            "{\"index\":1,\"time\":\"12:01\",\"files\":[],\"rewind_to\":101}\n",
        )
        .unwrap();

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds[0].rewind_to, Some(101));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_round_trips_base_rev() {
        let id = format!("test-changes-baserev-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);

        let mut r = change_round(1);
        r.base_rev = Some("a".repeat(40));
        append_session_change_blocking(id.clone(), r).unwrap();

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds[0].base_rev.as_deref(), Some("a".repeat(40).as_str()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn changes_load_without_base_rev_is_none() {
        // 2026-09-28 之前写下的轮记录没有该字段 → 必须照读（老会话不追溯、退化为 HEAD 累计）
        let id = format!("test-changes-nobaserev-{}", std::process::id());
        let path = changes_path(&id);
        let _ = std::fs::remove_file(&path);
        fs::create_dir_all(our_sessions_dir()).unwrap();
        fs::write(
            &path,
            "{\"index\":1,\"time\":\"12:01\",\"files\":[],\"rewind_to\":101,\"prompt\":\"提问 1\"}\n",
        )
        .unwrap();

        let rounds = load_session_changes_blocking(id.clone()).unwrap();
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].base_rev, None);
        let _ = std::fs::remove_file(&path);
    }
}
