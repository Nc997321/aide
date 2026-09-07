// ── 工作区显式注册表（registeredWorkspaces）──
//
// 工作区列表的唯一事实源：不再「扫 ~/.aide/claude/projects/ 推导」，而是由
// 用户动作（打开目录 / 首聊 cwd / 一次性迁移 / unhide）显式登记产生。内部
// 目录在结构上不可能混进侧栏，key 反向解码猜错的 UI 态从根上消失。
// 设计取舍全记录：docs/superpowers/plans/2026-09-07-workspace-explicit-registry.md
//
// 本文件是纯核心：只吃 `serde_json::Value` + `&str`，不碰 IO、不碰时钟——
// `now_ms` 由外壳注入、存在性由谓词闭包注入，脱离环境可单测。IO 壳
// （迁移 / ensure）在本文件后续任务追加，命令编排留在宿主 mod.rs。

use crate::commands::WorkspaceInfo;

/// 注册表条目——state.json `registeredWorkspaces` 数组元素（落盘 DTO）。
///
/// path 是身份主人（用户给的）；key 在注册时由 `path_to_key(path)` 算出后
/// **冻结**——它是 sessions/recent/lsp/codegraph/jdk 各段共用的身份，与磁盘
/// 转录目录对应，不随后续编码规则漂移。同一目录的斜杠变体（`C:/a` vs `C:\a`）
/// 经 path_to_key 塌缩成同一 key，天然去重。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredWorkspace {
    pub key: String,
    pub path: String,
    #[serde(default)]
    pub added_at: u64,
}

/// 容错解析注册表：缺字段 / 非数组 / 元素坏（缺 key 或 path）→ 逐条跳过，
/// 整体不炸（空注册表语义）。调用方拿到的永远是有序合法条目。
pub fn registered(config: &serde_json::Value) -> Vec<RegisteredWorkspace> {
    config
        .get("registeredWorkspaces")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| serde_json::from_value(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// trim + 去尾部 `\` `/`。全被吃掉（如 `"/"`）或空串返回空串，调用方拒绝。
pub fn normalize_registration_path(path: &str) -> String {
    path.trim().trim_end_matches(['\\', '/']).to_string()
}

/// 幂等登记：normalize 后算 key，dup key → 不动既有条目（path 的主人是先
/// 登记者）返回 false；新登记返回 true。空路径 / 序列化失败同样 false。
/// 段被写成非数组时不静默覆盖（用户数据优先），返回 false 由调用方决策。
pub fn register_in_config(config: &mut serde_json::Value, path: &str, now_ms: u64) -> bool {
    let path = normalize_registration_path(path);
    if path.is_empty() {
        return false;
    }
    let entry = RegisteredWorkspace {
        key: super::path_to_key(&path),
        path,
        added_at: now_ms,
    };
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let Some(obj) = config.as_object_mut() else {
        return false;
    };
    let arr = obj
        .entry("registeredWorkspaces".to_string())
        .or_insert_with(|| serde_json::json!([]));
    let Some(arr) = arr.as_array_mut() else {
        return false;
    };
    if arr
        .iter()
        .any(|v| v.get("key").and_then(|k| k.as_str()) == Some(entry.key.as_str()))
    {
        return false;
    }
    match serde_json::to_value(&entry) {
        Ok(v) => {
            arr.push(v);
            true
        }
        // String/u64 字段序列化不可能失败，守住编译器表达不了的最后一格
        Err(_) => false,
    }
}

/// 按 key 摘除（不存在 / 段非数组 noop）。返回是否摘了。
pub fn unregister_in_config(config: &mut serde_json::Value, key: &str) -> bool {
    let Some(arr) = config
        .get_mut("registeredWorkspaces")
        .and_then(|v| v.as_array_mut())
    else {
        return false;
    };
    let before = arr.len();
    arr.retain(|v| v.get("key").and_then(|k| k.as_str()) != Some(key));
    arr.len() != before
}

/// 注册表 → WorkspaceInfo DTO：`name` = 注册的真实 path（不再反向解码 key）、
/// `missing` = path 磁盘不存在（准确信号，取代旧的「解码猜失败」噪音）。
/// 按 name 不区分大小写排序，对齐 NTFS 枚举序，侧栏顺序不跳变。
/// `path_exists` 谓词注入：生产传磁盘探测，测试传闭包——核心不碰 fs。
pub fn infos_from_registry(
    config: &serde_json::Value,
    path_exists: impl Fn(&str) -> bool,
) -> Vec<WorkspaceInfo> {
    let mut infos: Vec<WorkspaceInfo> = registered(config)
        .into_iter()
        .map(|w| {
            let missing = !path_exists(&w.path);
            WorkspaceInfo {
                key: w.key,
                name: w.path,
                missing,
            }
        })
        .collect();
    infos.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    infos
}

// ── 启动一次性迁移（薄外壳 + 参数化核心）──
//
// 写侧与读侧的过渡桥：注册表落地前的历史转录目录（`~/.aide/claude/projects/`
// 全量扫描时代）按旧语义一次性播种进注册表——可解码的登记，hiddenWorkspaces
// 里用户隐藏过的不复活（降级容忍，见计划 D5），解码失败的（automations-
// aut-xxx 类内部目录）直接出局。marker 之后的启动不再扫目录。

/// 迁移核心（参数化可测，照 `session_config_roots_in` 范式）：扫 `projects_dir`
/// → hiddenWorkspaces 跳过 → `resolve_path_from_key` 解码失败跳过 → 幂等登记。
/// 返回本次新登记数；收尾写 marker `registeredWorkspacesMigrated`（重跑天然
/// 安全：marker 拦截 + 登记 dup-key false 双保险）。生产壳传真实路径。
pub fn migrate_registry_in(
    state: &mut serde_json::Value,
    projects_dir: &std::path::Path,
    now_ms: u64,
) -> usize {
    if !state.is_object() {
        *state = serde_json::json!({});
    }
    if state.get("registeredWorkspacesMigrated").and_then(|v| v.as_bool()) == Some(true) {
        return 0;
    }
    let hidden = super::hidden_keys(state);
    let mut count = 0usize;
    if let Ok(entries) = std::fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let key = entry.file_name().to_string_lossy().to_string();
            if hidden.iter().any(|h| h == &key) {
                continue;
            }
            let Some(path) = super::resolve_path_from_key(&key) else {
                continue;
            };
            if register_in_config(state, &path, now_ms) {
                count += 1;
            }
        }
    }
    state["registeredWorkspacesMigrated"] = serde_json::Value::Bool(true);
    count
}

/// 启动迁移外壳：单 `with_state_mut` 临界区（扫描 + 登记 + marker 原子落盘）。
/// marker 已真则直接 Ok，跳过扫目录。失败由调用方记日志下次启动重试。
pub fn ensure_registry_migrated() -> Result<(), String> {
    crate::commands::settings::with_state_mut(|state| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let count = migrate_registry_in(state, &crate::commands::claude_projects_dir(), now);
        if count > 0 {
            tracing::info!("workspace registry migration: {count} workspaces seeded");
        }
        Ok(())
    })
}

/// 按 key 查注册条目的 path（启动恢复活动工作区用：注册表是真实 path 的
/// 权威源，免去 try_decode 逐段探测）。查不到 → None，调用方走回退。
pub fn registered_path_for_key(config: &serde_json::Value, key: &str) -> Option<String> {
    registered(config)
        .into_iter()
        .find(|w| w.key == key)
        .map(|w| w.path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::workspace::path_to_key;
    use serde_json::json;

    // ── registered：容错解析 ──

    #[test]
    fn registered_missing_field_returns_empty() {
        assert!(registered(&json!({})).is_empty());
    }

    #[test]
    fn registered_malformed_section_returns_empty() {
        // 段被写成非数组（对象 / 字符串 / null）→ 空表语义，不炸
        assert!(registered(&json!({ "registeredWorkspaces": {} })).is_empty());
        assert!(registered(&json!({ "registeredWorkspaces": "junk" })).is_empty());
        assert!(registered(&serde_json::Value::Null).is_empty());
    }

    #[test]
    fn registered_skips_bad_entries_keeps_valid() {
        let cfg = json!({ "registeredWorkspaces": [
            { "key": "k1" },                                        // 缺 path → 跳过
            { "path": "C:\\a" },                                    // 缺 key → 跳过
            { "key": "k2", "path": "C:\\b", "addedAt": 42 },        // 合法（addedAt 有 default）
            "not-an-object",                                        // 非对象 → 跳过
        ]});
        let got = registered(&cfg);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].key, "k2");
        assert_eq!(got[0].path, r"C:\b");
        assert_eq!(got[0].added_at, 42);
    }

    // ── register_in_config：幂等登记 ──

    #[test]
    fn register_in_config_appends_entry() {
        let mut cfg = json!({});
        assert!(register_in_config(&mut cfg, r"C:\repos\alpha", 111));
        let got = registered(&cfg);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].key, "C--repos-alpha");
        assert_eq!(got[0].path, r"C:\repos\alpha");
        assert_eq!(got[0].added_at, 111);
    }

    #[test]
    fn register_in_config_is_idempotent_by_key() {
        let mut cfg = json!({});
        assert!(register_in_config(&mut cfg, r"C:\repos\alpha", 1));
        // 同 key 再登记：false，原条目 addedAt 不动（path 主人是先登记者）
        assert!(!register_in_config(&mut cfg, r"C:\repos\alpha", 999));
        assert_eq!(registered(&cfg)[0].added_at, 1);
    }

    #[test]
    fn register_normalizes_path_before_keying() {
        let mut cfg = json!({});
        // 首尾空白 + 尾部分隔符：normalize 后才参与 key 与落盘
        assert!(register_in_config(&mut cfg, r"  C:\repos\alpha\  ", 5));
        let got = registered(&cfg);
        assert_eq!(got[0].path, r"C:\repos\alpha");
        assert_eq!(got[0].key, "C--repos-alpha");
    }

    #[test]
    fn register_collapses_slash_variants_to_same_key() {
        let mut cfg = json!({});
        assert!(register_in_config(&mut cfg, "C:/repos/alpha", 1));
        // 斜杠变体塌缩成同一 key：第二次 false，path 保持先登记者的正斜杠形态
        assert!(!register_in_config(&mut cfg, r"C:\repos\alpha", 2));
        assert_eq!(registered(&cfg)[0].path, "C:/repos/alpha");
    }

    #[test]
    fn register_rejects_empty_after_normalize() {
        let mut cfg = json!({ "other": 1 });
        assert!(!register_in_config(&mut cfg, "  ", 1));
        assert!(!register_in_config(&mut cfg, "/", 1)); // 全被去尾吃掉
        assert!(!register_in_config(&mut cfg, "\\\\", 1));
        // 空输入不落任何段
        assert!(cfg.get("registeredWorkspaces").is_none());
    }

    #[test]
    fn register_malformed_section_does_not_clobber() {
        // 段被写成非数组：拒绝写入（false），不静默覆盖用户数据
        let mut cfg = json!({ "registeredWorkspaces": "junk" });
        assert!(!register_in_config(&mut cfg, r"C:\a", 1));
        assert_eq!(cfg["registeredWorkspaces"], "junk");
    }

    // ── unregister_in_config ──

    #[test]
    fn unregister_in_config_removes_by_key() {
        let mut cfg = json!({ "registeredWorkspaces": [
            { "key": "k1", "path": "C:\\a", "addedAt": 1 },
            { "key": "k2", "path": "C:\\b", "addedAt": 2 },
        ]});
        assert!(unregister_in_config(&mut cfg, "k1"));
        assert_eq!(registered(&cfg).len(), 1);
        assert_eq!(registered(&cfg)[0].key, "k2");
    }

    #[test]
    fn unregister_missing_key_noop() {
        let mut cfg = json!({ "registeredWorkspaces": [{ "key": "k1", "path": "C:\\a" }] });
        assert!(!unregister_in_config(&mut cfg, "zzz"));
        assert_eq!(registered(&cfg).len(), 1);
    }

    #[test]
    fn unregister_malformed_section_noop() {
        let mut cfg = json!({ "registeredWorkspaces": {} });
        assert!(!unregister_in_config(&mut cfg, "k1"));
    }

    // ── infos_from_registry：DTO 派生 ──

    #[test]
    fn infos_derive_key_name_missing() {
        let cfg = json!({ "registeredWorkspaces": [
            { "key": "C--a", "path": "C:\\a", "addedAt": 1 },
        ]});
        // 存在性由谓词注入：false → missing=true（准确信号语义）
        let infos = infos_from_registry(&cfg, |p| !p.ends_with("\\a"));
        assert_eq!(infos.len(), 1);
        assert!(infos[0].missing);
        assert_eq!(infos[0].name, r"C:\a");
        // key 用注册时冻结的值，不是运行时重算
        assert_eq!(infos[0].key, "C--a");

        let present = infos_from_registry(&cfg, |_| true);
        assert!(!present[0].missing);
    }

    #[test]
    fn infos_sorted_by_name_case_insensitive() {
        let cfg = json!({ "registeredWorkspaces": [
            { "key": "C--b", "path": "C:\\b", "addedAt": 1 },
            { "key": "C--A", "path": "C:\\A", "addedAt": 2 },
        ]});
        let infos = infos_from_registry(&cfg, |_| true);
        assert_eq!(infos[0].name, r"C:\A");
        assert_eq!(infos[1].name, r"C:\b");
    }

    #[test]
    fn infos_empty_registry_empty() {
        assert!(infos_from_registry(&json!({}), |_| true).is_empty());
    }

    // ── 启动迁移 ──

    #[test]
    fn migrates_decodable_dirs_skips_hidden_and_undecodable() {
        // 真实存在的目录 → 解码成功登记；幽灵 key（无任何前缀存在）→ 解码失败出局；
        // 存在但被 hiddenWorkspaces 记录的 → 用户隐藏过，不复活。
        let real = std::env::temp_dir().join("aide_mig_ws_real_x");
        let hidden_dir = std::env::temp_dir().join("aide_mig_ws_hidden_y");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&hidden_dir).unwrap();
        let projects_dir = std::env::temp_dir().join("aide_mig_projects_x");
        let _ = std::fs::remove_dir_all(&projects_dir);
        std::fs::create_dir_all(&projects_dir).unwrap();
        let real_key = path_to_key(&real.to_string_lossy());
        let hidden_key = path_to_key(&hidden_dir.to_string_lossy());
        // 形如合法 key（盘符 + --）但目标不存在 → try_decode 全前缀落空
        let ghost_key = "C--zzghost-aide-test-zz";
        std::fs::create_dir_all(projects_dir.join(&real_key)).unwrap();
        std::fs::create_dir_all(projects_dir.join(&hidden_key)).unwrap();
        std::fs::create_dir_all(projects_dir.join(ghost_key)).unwrap();

        let mut state = json!({
            "hiddenWorkspaces": [hidden_key],
            "other": 1,
        });
        let count = migrate_registry_in(&mut state, &projects_dir, 77);

        assert_eq!(count, 1, "只登记可解码且未隐藏的那一个");
        let got = registered(&state);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, real.to_string_lossy());
        assert_eq!(got[0].added_at, 77);
        assert_eq!(state["registeredWorkspacesMigrated"], json!(true));
        assert_eq!(state["other"], 1, "无关 state 字段保留");

        let _ = std::fs::remove_dir_all(&projects_dir);
        let _ = std::fs::remove_dir_all(&real);
        let _ = std::fs::remove_dir_all(&hidden_dir);
    }

    #[test]
    fn migrate_registry_in_marker_is_idempotent() {
        let real = std::env::temp_dir().join("aide_mig_ws_idem_z");
        std::fs::create_dir_all(&real).unwrap();
        let projects_dir = std::env::temp_dir().join("aide_mig_projects_idem");
        let _ = std::fs::remove_dir_all(&projects_dir);
        std::fs::create_dir_all(projects_dir.join(path_to_key(&real.to_string_lossy()))).unwrap();

        let mut state = json!({});
        assert_eq!(migrate_registry_in(&mut state, &projects_dir, 1), 1);
        // 二次调用：marker 拦截，0 新增、条目不重复
        assert_eq!(migrate_registry_in(&mut state, &projects_dir, 2), 0);
        assert_eq!(registered(&state).len(), 1);

        let _ = std::fs::remove_dir_all(&projects_dir);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn registered_path_for_key_found_and_miss() {
        let cfg = json!({ "registeredWorkspaces": [
            { "key": "C--a", "path": "C:\\a", "addedAt": 1 },
        ]});
        assert_eq!(registered_path_for_key(&cfg, "C--a"), Some(r"C:\a".to_string()));
        assert_eq!(registered_path_for_key(&cfg, "C--zzz"), None);
        assert_eq!(registered_path_for_key(&json!({}), "C--a"), None);
    }
}