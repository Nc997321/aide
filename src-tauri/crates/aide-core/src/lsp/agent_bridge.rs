//! agent-sidecar ↔ LSP 的协议桥（主进程侧）。
//!
//! `lsp_query` 事件进、`lsp_result` 命令出。
//! 唯一区别：查询本体**不跳 runner**——`LspManager` 就在主进程，拦截点直接派发。

use serde_json::Value;

/// One intercepted `lsp_query` event, validated.
pub struct LspQueryRequest {
    pub request_id: String,
    pub tool: String,
    pub args: Value,
    pub workspace_root: String,
}

/// Validate + extract an agent query event. None → not an lsp_query, or
/// malformed (missing request_id) — caller ignores it.
pub fn parse_lsp_query(event: &Value) -> Option<LspQueryRequest> {
    if event.get("type").and_then(|t| t.as_str()) != Some("lsp_query") {
        return None;
    }
    Some(LspQueryRequest {
        request_id: event.get("request_id")?.as_str()?.to_string(),
        tool: event
            .get("tool")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        args: event.get("args").cloned().unwrap_or(Value::Null),
        workspace_root: event
            .get("workspace_root")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Assemble the stdin command line payload: base payload + request_id + cmd tag.
pub fn build_result_command(request_id: &str, payload: Value) -> Value {
    let mut v = payload;
    v["cmd"] = Value::String("lsp_result".into());
    v["request_id"] = Value::String(request_id.into());
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_result_command_tags_cmd_and_request_id() {
        let v = build_result_command("r1", json!({"ok": true, "status": "ready", "results": []}));
        assert_eq!(v["cmd"], "lsp_result");
        assert_eq!(v["request_id"], "r1");
        assert_eq!(v["status"], "ready");
    }

    /// 回包 cmd 标不得串成 browser_result 之类别的桥——串了 sidecar
    /// 按 id 配对会失败，且**无任何提示**。
    #[test]
    fn build_result_command_never_tags_as_another_bridge() {
        let v = build_result_command("r1", json!({"ok": true}));
        assert_ne!(v["cmd"], "browser_result");
    }

    #[test]
    fn parse_requires_request_id() {
        assert!(parse_lsp_query(
            &json!({"type":"lsp_query","tool":"symbols","args":{},"workspace_root":"/x"})
        )
        .is_none());
    }

    #[test]
    fn parse_ignores_other_event_types() {
        assert!(parse_lsp_query(&json!({"type":"text_delta"})).is_none());
        assert!(parse_lsp_query(&json!({"type":"browser_query","request_id":"r"})).is_none());
    }

    #[test]
    fn parse_extracts_all_fields() {
        let r = parse_lsp_query(&json!({
            "type":"lsp_query","request_id":"r1","tool":"references",
            "args":{"name":"LspManager::get"},"workspace_root":"/proj"
        }))
        .unwrap();
        assert_eq!(r.request_id, "r1");
        assert_eq!(r.tool, "references");
        assert_eq!(r.args["name"], "LspManager::get");
        assert_eq!(r.workspace_root, "/proj");
    }
}
