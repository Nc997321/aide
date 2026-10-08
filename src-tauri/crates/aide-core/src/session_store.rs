//! Host 的会话档案（`~/.aide/sessions/<id>.json`：显示名 / 供应商 / 工作区归属 / 标签）
//! 与会话转录定位（按 session id 在所有配置根里找 `.jsonl`）。

use std::fs;
use std::path::PathBuf;

use aide_workspace::transcripts::find_jsonl_in as find_session_jsonl_in;
use serde::Serialize;

use crate::paths::{our_sessions_dir, session_config_roots};

/// 会话显示名的权威源：`~/.aide/sessions/<id>.json` 的 `name` 字段
/// （create/rename/auto_rename 三处写）。任何「按 id 展示会话名」的地方都应
/// 以它为准，元数据缺失时由调用方决定兜底。list_sessions 与 list_recent
/// （recent.json 只存快照名）都经此对齐。
pub fn our_session_name(session_id: &str) -> Option<String> {
    let path = our_sessions_dir().join(format!("{}.json", session_id));
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                return v
                    .get("name")
                    .and_then(|n| n.as_str())
                    .map(|s| s.to_string());
            }
        }
    }
    None
}

/// 会话绑定的供应商 id 权威源：`~/.aide/sessions/<id>.json` 的 `provider` 字段
/// （set_session_provider / 前端 stampProvider 写）。空串视为未记（filter）。
/// 「会话属于哪个供应商」的 Rust 侧解析（send_message 按会话 provider 构造 env）
/// 与前端 session_provider 命令共用此口径。
pub fn our_session_provider_field(session_id: &str) -> Option<String> {
    let path = our_sessions_dir().join(format!("{}.json", session_id));
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                return v
                    .get("provider")
                    .and_then(|p| p.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
            }
        }
    }
    None
}

/// 会话档案里记的工作区归属（`wsPath` / `wsKey`）。两个字段由同一次
/// `set_session_workspace` 成对落盘，所以也成对读取——拆成两个 getter 只会让
/// "读一半"（有 path 没 key）成为可能。空串视为未记（filter）。
///
/// 这是「会话属于哪个工作区」的**权威源**：send_message 的 cwd 兜底
/// （显式 workspace_root 缺席时）与前端 `session_workspace` 命令共用此口径。
/// 只读不推断：档案里没有就是没有，调用方自己决定兜底与留痕。
#[derive(Clone, Debug, Default, Serialize)]
pub struct SessionWorkspaceRef {
    #[serde(rename = "wsPath")]
    pub path: Option<String>,
    #[serde(rename = "wsKey")]
    pub key: Option<String>,
}

pub fn our_session_workspace(session_id: &str) -> SessionWorkspaceRef {
    let path = our_sessions_dir().join(format!("{}.json", session_id));
    let Ok(content) = fs::read_to_string(&path) else {
        return SessionWorkspaceRef::default();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else {
        return SessionWorkspaceRef::default();
    };
    let field = |k: &str| {
        v.get(k)
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    SessionWorkspaceRef {
        path: field("wsPath"),
        key: field("wsKey"),
    }
}

/// 不进正常会话列表的会话标签（`~/.aide/sessions/<id>.json` 的 `tags`）。
/// - `automation`：自动化运行产物。转录仍是普通 session JSONL（查看器直接复用），
///   但一个每天跑的任务 30 天产生 30+ 条记录，会把列表冲垮。
/// 新增一类「宿主内部会话」只需在这里加一个标签，所有列表扫描路径自动认。
pub const HIDDEN_SESSION_TAGS: &[&str] = &["automation"];

/// 档案 JSON 的 `tags` 是否含隐藏标签。纯函数，便于单测。
pub fn tags_mark_hidden(profile: &serde_json::Value) -> bool {
    profile
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|a| a.iter().any(|x| x.as_str().is_some_and(|t| HIDDEN_SESSION_TAGS.contains(&t))))
        .unwrap_or(false)
}

/// 会话是否是宿主内部会话（见 [`HIDDEN_SESSION_TAGS`]）：列表类扫描一律跳过。
/// 读不到档案 = 不隐藏（普通会话的常态）。
pub fn our_session_is_hidden(session_id: &str) -> bool {
    let path = our_sessions_dir().join(format!("{}.json", session_id));
    fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .is_some_and(|v| tags_mark_hidden(&v))
}

/// 多根查找核心：对每个配置根的 `projects/` 做一次 [`find_session_jsonl_in`]。
fn find_session_jsonl_across_roots(roots: &[PathBuf], id: &str) -> Vec<PathBuf> {
    roots
        .iter()
        .flat_map(|root| find_session_jsonl_in(&root.join("projects"), id))
        .collect()
}

/// `find_session_jsonl_in` scoped to **所有已知配置根**：先全局，再各作用域。
///
/// session id 全局唯一（UUID），多根扫描至多命中一处；全局排第一保证
/// 历史会话（会话目录隔离落地之前落的盘）优先命中，行为与改动前兼容。
pub fn find_session_jsonl_globally(id: &str) -> Vec<PathBuf> {
    find_session_jsonl_across_roots(&session_config_roots(), id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::session_config_roots_in;

    /// 会话目录隔离（2026-09-07）：automation 的转录落在作用域配置根下，
    /// 读侧必须对称——只扫全局的话，点开运行记录就是空白（线上实锤）。
    #[test]
    fn finds_jsonl_in_scoped_config_root_not_just_global() {
        let base = std::env::temp_dir().join("aide_mod_test_scoped_roots");
        let _ = fs::remove_dir_all(&base);

        // 全局配置根（历史会话形态）不放目标 id，防误命中
        let global_proj = base.join("claude").join("projects").join("C--ws");
        fs::create_dir_all(&global_proj).unwrap();
        fs::write(global_proj.join("other-id.jsonl"), b"{}").unwrap();

        // 作用域配置根（automation 隔离形态）：目标 jsonl 在这里
        let scoped_proj = base
            .join("scopes")
            .join("automation")
            .join("aut_x")
            .join("claude")
            .join("projects")
            .join("C--ws");
        fs::create_dir_all(&scoped_proj).unwrap();
        let id = "11111111-2222-3333-4444-555555555555";
        fs::write(scoped_proj.join(format!("{id}.jsonl")), b"{}").unwrap();

        let roots = session_config_roots_in(&base);
        assert_eq!(roots.len(), 2, "全局 + 一个作用域");
        assert_eq!(roots[0], base.join("claude"), "全局恒排第一");

        let hits = find_session_jsonl_across_roots(&roots, id);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].starts_with(&base.join("scopes")));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn tags_mark_hidden_only_for_hidden_kinds() {
        use serde_json::json;
        assert!(tags_mark_hidden(&json!({"tags": ["automation", "aut_1"]})));
        assert!(!tags_mark_hidden(&json!({"tags": ["other"]})));
        assert!(!tags_mark_hidden(&json!({"tags": []})));
        assert!(!tags_mark_hidden(&json!({"name": "x"})), "没有 tags 字段 = 普通会话");
        assert!(!tags_mark_hidden(&json!({"tags": "automation"})), "tags 必须是数组");
    }

    /// scopes 目录不存在（没人用过隔离）→ 退化为只有全局，不报错。
    #[test]
    fn session_config_roots_fall_back_to_global_only() {
        let base = std::env::temp_dir().join("aide_mod_test_no_scopes");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("claude")).unwrap();
        let roots = session_config_roots_in(&base);
        assert_eq!(roots, vec![base.join("claude")]);
        let _ = fs::remove_dir_all(&base);
    }
}
