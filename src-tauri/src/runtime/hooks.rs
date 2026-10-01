//! aide-core agent runtime 的 GUI 侧钩子（`aide_core::runtime::ports::AgentHooks`）：
//! 内嵌浏览器的 agent 工具查询、冻结诊断黑匣子——都是桌面进程的东西。

use std::sync::Arc;

use aide_core::runtime::ports::{AgentHooks, AgentStdin};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub struct DesktopAgentHooks(pub AppHandle);

impl AgentHooks for DesktopAgentHooks {
    /// 内嵌浏览器查询：执行体在 `runtime/browser_agent.rs`，这里只做「拦截 + 派发」。
    fn intercept(&self, event: &Value, stdin: &AgentStdin) -> bool {
        let Some(req) = crate::browser::agent_bridge::parse_browser_query(event) else {
            return false;
        };
        let app = self.0.clone();
        let stdin = Arc::clone(stdin);
        tokio::spawn(async move {
            super::browser_agent::handle(app, super::browser_agent::LOCAL_WINDOW, stdin, req).await;
        });
        true
    }

    fn observe(&self, event: &Value, raw_len: usize) {
        let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("unknown");
        // 诊断黑匣子：chat-event 出口按秒计量。session_init 的路由键在 _routing_id，其余事件
        // 的 session_id 即路由键。
        if let Some(diag) = self.0.try_state::<crate::diagnostics::DiagnosticsState>() {
            let sid = event
                .get("_routing_id")
                .or_else(|| event.get("session_id"))
                .and_then(|s| s.as_str())
                .unwrap_or("unknown");
            diag.record_chat_event(sid, event_type, raw_len as u64);
        }
        crate::diagnostics::trace::record("emit", event_type, "worker");
    }

    fn runtime_dead(&self, reason: &str) {
        crate::diagnostics::trace::record("runtime", reason, "worker");
    }
}
