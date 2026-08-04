use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::oneshot;

// ── IdAllocator ──

/// 进程内唯一 request id 分配器（不跨 server 持久化）。
pub struct IdAllocator(AtomicU64);

impl IdAllocator {
    pub fn new() -> Self {
        Self(AtomicU64::new(1))
    }

    pub fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::Relaxed)
    }
}

// ── Action ──

/// dispatch 一条 server→client 消息后的动作（manager/transport 据此 emit/resolve）。
#[derive(Debug)]
pub enum Action {
    /// 响应：关联到某 waiter。table 里无此 id → 调方静默丢（不崩）。
    ResolveWaiter {
        id: u64,
        result: serde_json::Value,
    },
    /// server 推诊断 → manager emit("lsp-diagnostics")。
    EmitDiagnostics {
        uri: String,
        diagnostics: serde_json::Value,
        version: Option<i64>,
    },
    /// window/logMessage → 日志。
    Log(String),
    /// window/showMessage → toast。
    ShowMessage(String),
    /// server→client request（罕见，如 workspace/configuration）→ v1 暂不处理，回空 response。
    ServerRequest {
        id: serde_json::Value,
        method: String,
        params: serde_json::Value,
    },
    Ignore,
}

// ── dispatch（纯函数）──

/// 纯函数：按消息字段判类型。无 IO，单测核心。
pub fn dispatch(msg: &serde_json::Value) -> Action {
    let obj = match msg.as_object() {
        Some(o) => o,
        None => return Action::Ignore,
    };
    let has_id = obj.contains_key("id");
    let has_method = obj.contains_key("method");

    if has_method && !has_id {
        // notification
        let method = obj.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let params = obj
            .get("params")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        return match method {
            "textDocument/publishDiagnostics" => {
                let uri = params
                    .get("uri")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let diagnostics = params
                    .get("diagnostics")
                    .cloned()
                    .unwrap_or(serde_json::json!([]));
                let version = params.get("version").and_then(|v| v.as_i64());
                Action::EmitDiagnostics {
                    uri,
                    diagnostics,
                    version,
                }
            }
            "window/logMessage" => {
                let msg = params
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Action::Log(msg)
            }
            "window/showMessage" => {
                let msg = params
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Action::ShowMessage(msg)
            }
            _ => Action::Ignore,
        };
    }

    if has_method && has_id {
        // server→client request
        let id = obj.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let method = obj
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let params = obj
            .get("params")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        return Action::ServerRequest { id, method, params };
    }

    if has_id {
        // response（result 或 error）
        let id = msg_id_u64(obj.get("id"));
        let result = obj
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        return Action::ResolveWaiter { id, result };
    }

    Action::Ignore
}

fn msg_id_u64(id: Option<&serde_json::Value>) -> u64 {
    id.and_then(|v| v.as_u64()).unwrap_or(0)
}

// ── Router ──

/// Router = id 分配器。transport/manager 用它编出站请求、路由入站消息。
pub struct Router {
    ids: IdAllocator,
}

impl Router {
    pub fn new() -> Self {
        Self {
            ids: IdAllocator::new(),
        }
    }

    /// 分配 id + 建通道。返回 (要发的消息体, id, tx, rx)。
    /// 调用方（async 上下文）负责 `table.lock().await.insert(id, tx)` 后再 send 消息体。
    pub fn next_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> (
        serde_json::Value,                              // 要发的消息体
        u64,                                             // id（调用方 insert 用）
        oneshot::Sender<serde_json::Value>,              // 注册进 table
        oneshot::Receiver<serde_json::Value>,            // 调用方 await
    ) {
        let id = self.ids.next();
        let (tx, rx) = oneshot::channel();
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        (msg, id, tx, rx)
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lsp::transport::RequestTable;
    use serde_json::json;

    #[test]
    fn id_allocator_monotonic() {
        let a = IdAllocator::new();
        assert_eq!(a.next(), 1);
        assert_eq!(a.next(), 2);
        assert_eq!(a.next(), 3);
    }

    #[test]
    fn dispatch_routes_response() {
        let msg = json!({"jsonrpc":"2.0","id":5,"result":{"x":1}});
        match dispatch(&msg) {
            Action::ResolveWaiter { id, result } => {
                assert_eq!(id, 5);
                assert_eq!(result["x"], 1);
            }
            other => panic!("expected ResolveWaiter, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_routes_notification() {
        let msg = json!({
            "jsonrpc":"2.0","method":"textDocument/publishDiagnostics",
            "params":{"uri":"file:///x.rs","diagnostics":[],"version":3}
        });
        match dispatch(&msg) {
            Action::EmitDiagnostics { uri, version, .. } => {
                assert_eq!(uri, "file:///x.rs");
                assert_eq!(version, Some(3));
            }
            other => panic!("expected EmitDiagnostics, got {other:?}"),
        }
    }

    #[test]
    fn dispatch_routes_log_and_show() {
        let log = json!({"method":"window/logMessage","params":{"message":"hi"}});
        assert!(matches!(dispatch(&log), Action::Log(m) if m == "hi"));
        let show = json!({"method":"window/showMessage","params":{"message":"warn"}});
        assert!(matches!(dispatch(&show), Action::ShowMessage(m) if m == "warn"));
    }

    #[test]
    fn dispatch_routes_server_request() {
        let msg = json!({"jsonrpc":"2.0","id":9,"method":"workspace/configuration","params":{}});
        match dispatch(&msg) {
            Action::ServerRequest { method, .. } => assert_eq!(method, "workspace/configuration"),
            other => panic!("expected ServerRequest, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn dispatch_unknown_id_response_dropped_silently() {
        // response id=99，table 里只有 id=1 的 waiter → 99 取不到 sender，静默丢，不崩。
        let mut table = RequestTable::new();
        let (tx1, rx1) = oneshot::channel();
        table.insert(1, tx1);
        let msg = json!({"jsonrpc":"2.0","id":99,"result":{}});
        match dispatch(&msg) {
            Action::ResolveWaiter { id, .. } => {
                assert_eq!(id, 99);
                let taken = table.take(99);
                assert!(taken.is_none(), "unknown id must not be in table");
            }
            other => panic!("expected ResolveWaiter, got {other:?}"),
        }
        // waiter 1 仍挂着，未被 99 误 resolve
        drop(rx1); // 不 await，仅验未误触
    }

    #[tokio::test]
    async fn router_next_request_round_trip_via_table() {
        let router = Router::new();
        let mut table = RequestTable::new();
        let (msg, id, tx, rx) = router.next_request("textDocument/definition", json!({}));
        assert_eq!(msg["method"], "textDocument/definition");
        table.insert(id, tx);
        // 模拟 server 回响应
        let resp = json!({"jsonrpc":"2.0","id":id,"result":[{"uri":"file:///x.rs","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}]});
        match dispatch(&resp) {
            Action::ResolveWaiter { id: rid, result } => {
                assert_eq!(rid, id);
                if let Some(sender) = table.take(rid) {
                    sender.send(result).unwrap();
                }
            }
            other => panic!("got {other:?}"),
        }
        let got = rx.await.unwrap();
        assert!(got.as_array().unwrap().len() == 1);
    }
}
