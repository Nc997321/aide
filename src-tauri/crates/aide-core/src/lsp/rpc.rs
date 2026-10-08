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
    /// `Err` = 服务器用 JSON-RPC error **拒绝**了这条请求——不是结果（见 `WaiterReply`）。
    ResolveWaiter {
        id: u64,
        result: crate::lsp::transport::WaiterReply,
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
    /// server→client request（罕见，如 workspace/configuration）→ v1 仅记日志、不回 response
    ///（`method`/`params` 未读取，保留供未来 handler 处理；真要回 response 也只需在 reader 按 id 回）。
    #[allow(dead_code)]
    ServerRequest {
        id: serde_json::Value,
        method: String,
        params: serde_json::Value,
    },
    /// server→client `language/status` 通知（jdtls 等）。manager 据此判 Java 功能就绪——
    /// 非 Java 或非就绪阶段由 manager 按 profile 忽略。params: { type: string|int, message: string }。
    /// `status_type` 保留原始 Value（新版 jdtls 是 string "ServiceReady"、旧版是 int），容错不丢。
    ServerStatus {
        status_type: serde_json::Value,
        message: String,
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
            // jdtls 功能就绪进度通知（Starting/Started/ServiceReady/ProjectStatus/Error…）。
            // manager 按 profile 决定是否消费（仅 Java 认 ServiceReady 置 ready）。
            "language/status" => {
                let status_type = params
                    .get("type")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                let message = params
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                Action::ServerStatus {
                    status_type,
                    message,
                }
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
        // response：**result 与 error 分道走**。error 曾被折叠成 `result: null`，
        // 于是「服务器拒答」在整条链路上伪装成「服务器答了：空」。
        let id = msg_id_u64(obj.get("id"));
        let result = match obj.get("error") {
            Some(err) => Err(error_message(err)),
            None => Ok(obj.get("result").cloned().unwrap_or(serde_json::Value::Null)),
        };
        return Action::ResolveWaiter { id, result };
    }

    Action::Ignore
}

/// JSON-RPC error → 可读消息。**带 code**：排查时一眼看出是谁拒的、拒的是什么。
fn error_message(err: &serde_json::Value) -> String {
    let msg = err
        .get("message")
        .and_then(|m| m.as_str())
        .unwrap_or("language server returned an error");
    match err.get("code").and_then(|c| c.as_i64()) {
        Some(code) => format!("{msg} (code {code})"),
        None => msg.to_string(),
    }
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
        serde_json::Value,                    // 要发的消息体
        u64,                                  // id（调用方 insert 用）
        oneshot::Sender<crate::lsp::transport::WaiterReply>, // 注册进 table
        oneshot::Receiver<crate::lsp::transport::WaiterReply>, // 调用方 await
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
                assert_eq!(result.expect("result 型响应")["x"], 1);
            }
            other => panic!("expected ResolveWaiter, got {other:?}"),
        }
    }

    /// **error 不是结果。** 真机事故：折叠成 `null` 之后，「服务器拒答」在整条链路上
    /// 与「服务器确认没有」无法区分，于是吐出假否定（红线「空 ≠ 没有」在传输层的落点）。
    #[test]
    fn dispatch_error_response_is_not_a_result() {
        let msg =
            json!({"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"No Project."}});
        match dispatch(&msg) {
            Action::ResolveWaiter { id, result } => {
                assert_eq!(id, 7);
                let err = result.expect_err("error 响应不许落到 Ok");
                assert!(err.contains("No Project."), "原文要留着，got {err}");
                assert!(err.contains("-32000"), "code 也要留着：一眼看出是谁拒的，got {err}");
            }
            other => panic!("expected ResolveWaiter, got {other:?}"),
        }
        // 无 result 字段的 error（code 也缺）→ 仍是 Err，不能退化成 result:null
        let only_error = json!({"jsonrpc":"2.0","id":8,"error":{"message":"boom"}});
        match dispatch(&only_error) {
            Action::ResolveWaiter { result, .. } => assert_eq!(result.unwrap_err(), "boom"),
            other => panic!("got {other:?}"),
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

    #[test]
    fn dispatch_routes_language_status() {
        // 新版 jdtls：type 是 string "ServiceReady"
        let msg = json!({"method":"language/status","params":{"type":"ServiceReady","message":"Service ready"}});
        match dispatch(&msg) {
            Action::ServerStatus {
                status_type,
                message,
            } => {
                assert_eq!(status_type, "ServiceReady");
                assert_eq!(message, "Service ready");
            }
            other => panic!("expected ServerStatus, got {other:?}"),
        }
        // 旧版 jdtls：type 是 int（messageType），status_type 保留原始数值不丢
        let msg_int =
            json!({"method":"language/status","params":{"type":3,"message":"Service ready"}});
        match dispatch(&msg_int) {
            Action::ServerStatus { status_type, .. } => assert_eq!(status_type, 3),
            other => panic!("expected ServerStatus(int), got {other:?}"),
        }
        // 缺 params.type → null，不崩（manager 容错判非就绪）
        let msg_none = json!({"method":"language/status","params":{"message":"x"}});
        match dispatch(&msg_none) {
            Action::ServerStatus { status_type, .. } => assert!(status_type.is_null()),
            other => panic!("expected ServerStatus(null type), got {other:?}"),
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
        let got = rx.await.unwrap().expect("result 型响应");
        assert!(got.as_array().unwrap().len() == 1);
    }
}
