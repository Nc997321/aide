//! aide.exe ↔ aide-codegraph.exe 的 stdio JSON-RPC 协议（一行一条 JSON 消息）。
//!
//! 优化项二（CodeGraph 进程隔离）的「签名合同」：主进程 proxy 与 runner
//! main 各自编解码这套消息形状。协议类型集中在此，两侧不得私自手拼字段
//! ——改协议 = 改这里 + 两侧编译器对账。
//!
//! 消息流：
//! - 请求（主 → runner）：`{"id": 7, "method": "build_index", "params": {...}}`
//! - 响应（runner → 主）：`{"id": 7, "ok": true, "result": {...}}`
//!   或 `{"id": 7, "ok": false, "error": "..."}`
//! - 通知（runner → 主，无 id、不回执）：进度等单向推送。
//!
//! 方法集（roadmap 建议集的实现）：
//! | method          | params                                  | result                |
//! |-----------------|-----------------------------------------|-----------------------|
//! | build_index     | project_root, force, embedder, proxy    | 构建结果 JSON         |
//! | goto_definition | word, file, line, project_root, score_threshold | Vec<QueryResult> |
//! | close           | project_root                            | null                  |
//! | reindex_file    | project_root, file                      | 状态 JSON             |
//! | rescan          | project_root                            | 状态 JSON             |
//! | agent_query     | tool, args, project_root, trusted, score_threshold | 结果 JSON |
//! | shutdown        | （无）                                   | null，进程随后退出     |
//!
//! 语义要点：
//! - `build_index` 是分钟级长请求：主进程的 invoke 一直 await（与今天 Tauri
//!   command 的前端合同一致），期间进度经 `progress` 通知推送。
//! - `goto_definition` 可与 build 并发（runner 内 spawn_blocking 分发，锁语义
//!   与进程隔离前完全一致）。
//! - `agent_query.trusted` 由主进程计算（信任是政策，归属主进程；runner 是
//!   机制，盲执行）。
//! - runner stdin EOF（主进程死亡）⇒ runner 自行退出——这是天然的看门狗。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 主 → runner 请求。
#[derive(Debug, Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// runner → 主响应。
#[derive(Debug, Serialize, Deserialize)]
pub struct RpcResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RpcResponse {
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, error: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(error.into()),
        }
    }
}

/// runner → 主通知（进度等）。`notification` 是通知类型名。
#[derive(Debug, Serialize, Deserialize)]
pub struct RpcNotification {
    pub notification: String,
    #[serde(flatten)]
    pub payload: Value,
}

/// 进度通知负载：与主进程同步命令 `codegraph_build_progress` 的返回形状一致
/// （前端轮询合同不变——通知更新主进程侧 atomics，poll 命令照旧读）。
#[derive(Debug, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub active: bool,
    pub done: usize,
    pub total: usize,
    pub current: String,
    /// 结构层是否已换入（Phase 1 完成即可精确跳转，embed 仍在后台跑）。
    pub index_ready: bool,
}

/// 日志通知负载：runner 侧 tracing 落 stderr（打包时不依赖），关键 warn/info
/// 同时以通知回传，主进程记入自己的日志，崩溃诊断不用翻两个文件。
#[derive(Debug, Serialize, Deserialize)]
pub struct LogPayload {
    pub level: String,
    pub message: String,
}

/// 方法名常量——两侧引用同一份，拼错即编译期对账不上。
pub mod methods {
    pub const BUILD_INDEX: &str = "build_index";
    pub const GOTO_DEFINITION: &str = "goto_definition";
    pub const CLOSE: &str = "close";
    pub const REINDEX_FILE: &str = "reindex_file";
    pub const RESCAN: &str = "rescan";
    pub const AGENT_QUERY: &str = "agent_query";
    pub const SHUTDOWN: &str = "shutdown";
}

/// 通知名常量。
pub mod notifications {
    pub const PROGRESS: &str = "progress";
    pub const LOG: &str = "log";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_parses_without_params_field() {
        let req: RpcRequest = serde_json::from_str(r#"{"id": 3, "method": "shutdown"}"#).unwrap();
        assert_eq!(req.id, 3);
        assert_eq!(req.method, "shutdown");
        assert!(req.params.is_null());
    }

    #[test]
    fn response_omits_empty_fields_on_the_wire() {
        let s = serde_json::to_string(&RpcResponse::ok(1, serde_json::json!({"a": 1}))).unwrap();
        assert!(
            !s.contains("error"),
            "ok response must not carry error key: {s}"
        );
        let s = serde_json::to_string(&RpcResponse::err(2, "boom")).unwrap();
        assert!(
            !s.contains("result"),
            "err response must not carry result key: {s}"
        );
    }

    /// 通知用 flatten：payload 字段与 notification 平铺在同一层，主进程按
    /// notification 名解析其余字段。手拼拼错的兜底契约。
    #[test]
    fn notification_flattens_payload() {
        let n = RpcNotification {
            notification: "progress".into(),
            payload: serde_json::json!({"active": true, "done": 2, "total": 10, "current": "扫描", "index_ready": false}),
        };
        let s = serde_json::to_string(&n).unwrap();
        assert!(s.contains(r#""notification":"progress""#), "{s}");
        assert!(s.contains(r#""active":true"#), "{s}");
        // 回读：flatten 的字段还原进 payload
        let back: RpcNotification = serde_json::from_str(&s).unwrap();
        assert_eq!(back.payload["total"], serde_json::json!(10));
    }

    /// 进度负载与前端轮询合同对账：五个键一个不能少。
    #[test]
    fn progress_payload_shape_matches_poll_contract() {
        let p = ProgressPayload {
            active: true,
            done: 1,
            total: 5,
            current: "解析 a.ts".into(),
            index_ready: true,
        };
        let v = serde_json::to_value(&p).unwrap();
        for key in ["active", "done", "total", "current", "index_ready"] {
            assert!(v.get(key).is_some(), "progress payload missing key {key}");
        }
    }
}
