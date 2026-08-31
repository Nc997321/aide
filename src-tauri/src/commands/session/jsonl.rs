// .jsonl 直读域：末事件快照（session_last_event）、文件尺寸 / 截断（revertRound
// 撤回锚点）、末条消息摘要（自动化 RunRecord.summary）。

use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use tauri::State;

use crate::commands::{find_session_jsonl_globally, LastEventInfo, WorkspaceState};

/// 同 load_messages：整读 .jsonl 再反向扫描，转 blocking 线程。
#[tauri::command]
pub async fn session_last_event(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<LastEventInfo, String> {
    tokio::task::spawn_blocking(move || session_last_event_blocking(session_id))
        .await
        .map_err(|e| format!("session_last_event task panicked: {}", e))?
}

fn session_last_event_blocking(session_id: String) -> Result<LastEventInfo, String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(LastEventInfo {
            event_type: None,
            stop_reason: None,
            timestamp: None,
        });
    };

    let file =
        fs::File::open(&jsonl_path).map_err(|e| format!("Failed to open session file: {}", e))?;
    let reader = BufReader::new(file);

    // Scan lines in reverse to find the last meaningful conversation event
    // (assistant or user). The actual last line is often a system or
    // file-history-snapshot event, which doesn't tell us if Claude is done.
    let lines: Vec<String> = reader.lines().filter_map(|l| l.ok()).collect();
    for line in lines.iter().rev() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if event_type == "assistant" || event_type == "user" {
                let stop_reason = v
                    .get("message")
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
                let timestamp = v
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string());
                return Ok(LastEventInfo {
                    event_type: Some(event_type.to_string()),
                    stop_reason,
                    timestamp,
                });
            }
        }
    }
    // No conversation events found — treat as empty
    Ok(LastEventInfo {
        event_type: None,
        stop_reason: None,
        timestamp: None,
    })
}
/// 每轮对话结束都会调用一次（takeSnapshot 记录撤回锚点），必须 async——同步版本
/// 曾在诊断黑匣子里被实锤为 Rust 主线程冻结的嫌疑对象：`find_session_jsonl_globally`
/// 遍历 `~/.aide/claude/projects/` 是同步磁盘 IO，杀软实时扫描 / 磁盘争抢时可能被拖到
/// 秒级甚至更久，堵在 Tauri 主线程上会连累所有后续命令排队（详见 CLAUDE.md「同步
/// command 禁止重 IO」）。同名兄弟 `session_last_event` 早已是 async，这两个是漏网之鱼。
#[tauri::command]
pub async fn session_jsonl_size(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
) -> Result<u64, String> {
    tokio::task::spawn_blocking(move || session_jsonl_size_blocking(session_id))
        .await
        .map_err(|e| format!("session_jsonl_size task panicked: {}", e))?
}

fn session_jsonl_size_blocking(session_id: String) -> Result<u64, String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(0);
    };

    let metadata =
        fs::metadata(&jsonl_path).map_err(|e| format!("Failed to read jsonl metadata: {}", e))?;

    Ok(metadata.len())
}

#[tauri::command]
pub async fn session_truncate_jsonl(
    _workspace_state: State<'_, WorkspaceState>,
    session_id: String,
    byte_pos: u64,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || session_truncate_jsonl_blocking(session_id, byte_pos))
        .await
        .map_err(|e| format!("session_truncate_jsonl task panicked: {}", e))?
}

fn session_truncate_jsonl_blocking(session_id: String, byte_pos: u64) -> Result<(), String> {
    let Some(jsonl_path) = find_session_jsonl_globally(&session_id).into_iter().next() else {
        return Ok(());
    };

    let file = fs::OpenOptions::new()
        .write(true)
        .open(&jsonl_path)
        .map_err(|e| format!("Failed to open jsonl: {}", e))?;

    file.set_len(byte_pos)
        .map_err(|e| format!("Failed to truncate jsonl: {}", e))?;

    Ok(())
}
/// 取 jsonl 末条消息的文本（≤80 字）。仅供自动化运行摘要（RunRecord.summary）——
/// 运行终态时读本运行转录的尾行；会话列表已不展示末消息预览。
///
/// seek 到文件尾往回读末段找最后一个 `\n`：不整读大 .jsonl。窗口 64KB 起，
/// 末行超窗（窗口内无 `\n`）倍增扩大，最终整读兜底。
pub(crate) fn last_jsonl_message(jsonl_path: &std::path::Path) -> String {
    let file = match fs::File::open(jsonl_path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let file_len = match file.metadata() {
        Ok(m) => m.len(),
        // 不可达：File::open 成功的句柄 metadata 必然成功（仅文件系统级异常才可能）
        Err(_) => return String::new(),
    };
    let mut window = 64 * 1024u64;
    loop {
        let read_len = file_len.min(window) as usize;
        let start = file_len - read_len as u64;
        let mut buf = vec![0u8; read_len];
        let mut f = &file;
        if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err() {
            // 不可达：成功打开的常规文件 seek/read 不会失败（仅 IO 层异常才可能）
            return String::new();
        }
        if let Some(pos) = buf.iter().rposition(|&b| b == b'\n') {
            // 末行起点：文件末尾无 \n（EOF 半截行）时取最后一个 \n 之后；
            // 文件以 \n 结尾时取倒数第二个 \n 之后（末行 = 最后一个完整行）。
            let start = if pos + 1 < buf.len() {
                pos + 1
            } else {
                buf[..pos]
                    .iter()
                    .rposition(|&b| b == b'\n')
                    .map(|p| p + 1)
                    .unwrap_or(0)
            };
            // \r\n 对齐（sidecar parseLines 兼容），末行剥 \r
            let last_line = String::from_utf8_lossy(&buf[start..])
                .trim_end_matches('\r')
                .to_string();
            let text = last_message_text(&last_line);
            if !text.is_empty() {
                return text;
            }
            // 末行解析失败 = 窗口截断了大行（行尾 \n 在窗内但行头在窗外）→ 扩大窗口重试
            if window >= file_len {
                return String::new();
            }
            window = (window * 2).min(file_len);
            continue;
        }
        if window >= file_len {
            // 整读仍无 \n：单行文件，整段即末行
            return last_message_text(
                &String::from_utf8_lossy(&buf)
                    .trim_end_matches('\r')
                    .to_string(),
            );
        }
        window = (window * 2).min(file_len);
    }
}

/// 从一行 JSON 提取消息文本（≤80 字）。纯函数便于单测。
fn last_message_text(line: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(line) {
        if let Some(content_val) = v.get("message").and_then(|m| m.get("content")) {
            let text = if let Some(s) = content_val.as_str() {
                s.to_string()
            } else if let Some(arr) = content_val.as_array() {
                let texts: Vec<&str> = arr
                    .iter()
                    .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|c| c.get("text").and_then(|t| t.as_str()))
                    .collect();
                texts.join(" ")
            } else {
                String::new()
            };
            if !text.is_empty() {
                return text.chars().take(80).collect();
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 与 history 分页测试同款临时文件惯例（std::env::temp_dir + pid）

    fn line(v: serde_json::Value) -> String {
        v.to_string()
    }

    fn temp_jsonl(name: &str, content: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("aide-page-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_file(&p);
        std::fs::write(&p, content).unwrap();
        p
    }
    /// 标准会话：8 行 → 6 条消息（L4 是 tool_result-only 行不成为消息，
    /// L3+L5 连续 assistant 行合并成一条）。
    fn standard_lines() -> Vec<String> {
        vec![
            line(serde_json::json!({ "type": "user", "message": { "content": "你好" } })),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "你好,有什么可以帮你?" }] } }),
            ),
            line(
                serde_json::json!({ "type": "user", "message": { "content": "帮我看看这个文件" } }),
            ),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "a.ts" } }] } }),
            ),
            line(
                serde_json::json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "文件内容……", "is_error": false }] } }),
            ),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "文件内容如下" }] } }),
            ),
            line(serde_json::json!({ "type": "user", "message": { "content": "谢谢" } })),
            line(
                serde_json::json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "不客气" }] } }),
            ),
        ]
    }
    // ── last_jsonl_message seek 优化（末段反向读 + 纯函数提取）──

    #[test]
    fn last_message_extracts_string_content() {
        let line =
            line(serde_json::json!({ "type": "assistant", "message": { "content": "你好" } }));
        assert_eq!(last_message_text(&line), "你好");
    }

    #[test]
    fn last_message_joins_text_blocks_skipping_non_text() {
        let line = line(serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "a" },
                { "type": "tool_use", "id": "t1", "name": "Bash" },
                { "type": "text", "text": "b" },
            ] },
        }));
        assert_eq!(last_message_text(&line), "a b");
    }

    #[test]
    fn last_message_truncates_to_80_chars() {
        let line = line(
            serde_json::json!({ "type": "assistant", "message": { "content": "x".repeat(200) } }),
        );
        assert_eq!(last_message_text(&line).chars().count(), 80);
    }

    #[test]
    fn last_message_invalid_line_returns_empty() {
        assert_eq!(last_message_text("not json"), "");
    }

    #[test]
    fn last_jsonl_seek_reads_last_line_without_full_scan() {
        let lines = vec![
            line(serde_json::json!({ "type": "user", "message": { "content": "第一轮" } })),
            line(serde_json::json!({ "type": "assistant", "message": { "content": "最后一轮" } })),
        ];
        let p = temp_jsonl("lastmsg", &(lines.join("\n") + "\n"));
        assert_eq!(last_jsonl_message(&p), "最后一轮");
    }

    #[test]
    fn last_jsonl_eof_half_line_returns_empty() {
        // EOF 半截行（无 \n 结尾）：末段取到半截 JSON → 解析失败 → 空（与原整读行为一致）
        let mut content = standard_lines().join("\n") + "\n";
        content.push_str("{\"type\":\"assistant\",\"message\":{\"content\":\"半截");
        let p = temp_jsonl("lasthalf", &content);
        assert_eq!(last_jsonl_message(&p), "");
    }

    #[test]
    fn last_jsonl_oversized_line_expands_window() {
        // 70KB 末行 > 64KB 首窗：首窗末行是截断 JSON → 扩大窗口重试取到完整行
        let big = "x".repeat(70 * 1024);
        let lines = vec![
            line(serde_json::json!({ "type": "user", "message": { "content": "第一轮" } })),
            line(serde_json::json!({ "type": "assistant", "message": { "content": big } })),
        ];
        let p = temp_jsonl("lastbig", &(lines.join("\n") + "\n"));
        let got = last_jsonl_message(&p);
        assert_eq!(got.chars().count(), 80);
        assert!(got.starts_with("xxx"));
    }

    #[test]
    fn last_jsonl_missing_file_returns_empty() {
        let p = std::env::temp_dir().join(format!("aide-page-missing-{}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        assert_eq!(last_jsonl_message(&p), "");
    }

    #[test]
    fn last_jsonl_single_line_without_newline_uses_whole_buffer() {
        // 单行文件无 \n：整段即末行（走「整读仍无 \n」分支）
        let p = temp_jsonl(
            "lastsingle",
            &line(serde_json::json!({ "type": "user", "message": { "content": "唯一一行" } })),
        );
        assert_eq!(last_jsonl_message(&p), "唯一一行");
    }

    #[test]
    fn last_message_no_content_returns_empty() {
        assert_eq!(last_message_text(r#"{"type":"assistant"}"#), "");
    }

    #[test]
    fn last_message_non_string_non_array_content_returns_empty() {
        assert_eq!(
            last_message_text(r#"{"type":"assistant","message":{"content":42}}"#),
            ""
        );
    }

    #[test]
    fn last_message_empty_string_content_returns_empty() {
        assert_eq!(
            last_message_text(r#"{"type":"assistant","message":{"content":""}}"#),
            ""
        );
    }
}
