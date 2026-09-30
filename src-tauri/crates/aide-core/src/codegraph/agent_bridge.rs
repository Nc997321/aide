//! agent-sidecar ↔ CodeGraph 的协议桥（主进程侧）。
//!
//! 迁移对账：这三个符号原来长在 `codegraph/agent.rs`（随引擎整体迁去
//! runner 了），但它们是 **sidecar 协议**（`codegraph_query` 事件进、
//! `codegraph_result` 命令出）的合同，属于主进程——查询本体经
//! `CodeGraphService::agent_query` RPC 转发给 runner 执行。

use std::sync::Arc;

use serde_json::Value;

use crate::registry::blocking;
use crate::Core;

/// One intercepted `codegraph_query` event, validated.
pub struct AgentQueryRequest {
    pub request_id: String,
    pub tool: String,
    pub args: Value,
    pub project_root: String,
}

/// Validate + extract an agent query event. None → not a codegraph_query, or
/// malformed (missing request_id) — caller ignores it.
pub fn parse_codegraph_query(event: &Value) -> Option<AgentQueryRequest> {
    if event.get("type").and_then(|t| t.as_str()) != Some("codegraph_query") {
        return None;
    }
    Some(AgentQueryRequest {
        request_id: event.get("request_id")?.as_str()?.to_string(),
        tool: event
            .get("tool")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        args: event.get("args").cloned().unwrap_or(Value::Null),
        project_root: event
            .get("project_root")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Assemble the stdin command line payload: base payload + request_id + cmd tag.
pub fn build_result_command(request_id: &str, payload: Value) -> Value {
    let mut v = payload;
    v["cmd"] = Value::String("codegraph_result".into());
    v["request_id"] = Value::String(request_id.into());
    v
}

/// 答一条 agent 查询，返回 `codegraph_result` 命令载荷（写回 sidecar stdin）。
///
/// 政策层输入由这里现算：阈值按当前 settings 现解析（query-time，不缓存、不重建）；
/// trusted 同理——信任是政策，runner 是机制。
pub async fn answer(core: &Arc<Core>, req: &AgentQueryRequest) -> Value {
    let settings = core.settings.clone();
    let trust_root = req.project_root.clone();
    let (score_threshold, trusted) = blocking(move || {
        Ok((
            super::query_score_threshold(&settings),
            crate::commands::workspace::is_path_trusted(&trust_root),
        ))
    })
    .await
    .unwrap_or((0.35, false));
    let body = core
        .codegraph
        .agent_query(&req.tool, &req.args, &req.project_root, trusted, score_threshold)
        .await
        .unwrap_or_else(|e| serde_json::json!({ "ok": false, "status": "error", "error": e }));
    build_result_command(&req.request_id, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_result_command_tags_cmd_and_request_id() {
        let v = build_result_command("r1", json!({"ok": true, "status": "ready", "results": []}));
        assert_eq!(v["cmd"], "codegraph_result");
        assert_eq!(v["request_id"], "r1");
        assert_eq!(v["status"], "ready");
    }

    #[test]
    fn parse_requires_request_id() {
        assert!(parse_codegraph_query(
            &json!({"type":"codegraph_query","tool":"find_symbol","args":{},"project_root":"/x"})
        )
        .is_none());
        let r = parse_codegraph_query(&json!({"type":"codegraph_query","request_id":"r1","tool":"find_symbol","args":{"name":"x"},"project_root":"/x"})).unwrap();
        assert_eq!(r.request_id, "r1");
        assert_eq!(r.tool, "find_symbol");
        assert!(parse_codegraph_query(&json!({"type":"text_delta"})).is_none());
    }
}
