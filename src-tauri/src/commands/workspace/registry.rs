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

#[cfg(test)]
mod tests {
    use super::*;
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
}