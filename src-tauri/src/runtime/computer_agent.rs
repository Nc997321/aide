//! 电脑操作（`aide-computer`）的桌面壳接线：拦截 `computer_query`、把会话事件喂给执行器、急停时中断会话。
//!
//! **为什么在 GUI 进程而不在 Host**：屏幕在用户眼前这台机器上，Host 可能在 WSL / SSH 上
//! （设计：docs/superpowers/specs/2026-10-19-computer-use-design.md §3）。
//! 本机 Host 的查询经 runtime 钩子进来、回包写 stdin；远程 Host 的查询经 Host 事件进来、
//! 回包经 `agent_tool_result` 回到那台 Host（同内嵌浏览器）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use aide_computer::{Computer, HostHooks, Request};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

use crate::remote_workspace::path::HostId;
use crate::remote_workspace::RemoteWorkspaces;

/// 托管状态。
pub struct ComputerState {
    computer: Computer,
    hooks: Arc<DesktopComputerHooks>,
}

/// 执行器回调：急停中断会话、提示条上的会话名。记着每个会话来自哪台 Host（`None` = 本机）。
pub struct DesktopComputerHooks {
    app: AppHandle,
    origins: Mutex<HashMap<String, Option<HostId>>>,
}

impl DesktopComputerHooks {
    fn note_origin(&self, session_id: &str, host: Option<HostId>) {
        let mut m = self.origins.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() > 256 {
            m.clear();
        }
        m.insert(session_id.to_string(), host);
    }

    fn origin(&self, session_id: &str) -> Option<Option<HostId>> {
        self.origins.lock().unwrap_or_else(|e| e.into_inner()).get(session_id).cloned()
    }
}

impl HostHooks for DesktopComputerHooks {
    fn emergency_stop(&self, session_id: &str) {
        let app = self.app.clone();
        let sid = session_id.to_string();
        let origin = self.origin(session_id).flatten();
        tauri::async_runtime::spawn(async move {
            // 走现有的 interrupt：sidecar 收尾这一轮并广播，所有客户端都看得到。
            let result = match origin {
                None => {
                    let core = app.state::<Arc<aide_core::Core>>().inner().clone();
                    core.runtime.send_to_runtime(&json!({ "cmd": "interrupt", "session_id": sid })).await
                }
                Some(host) => {
                    let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
                    match svc.connection(&host).await {
                        Ok(c) => c.invoke("interrupt_session", json!({ "sessionId": sid })).await.map(|_| ()),
                        Err(e) => Err(e),
                    }
                }
            };
            match result {
                Ok(()) => tracing::info!(session = %sid, "computer use: emergency stop interrupted the session"),
                Err(e) => tracing::warn!(session = %sid, "computer use: emergency stop could not interrupt: {e}"),
            }
        });
    }

    fn session_label(&self, session_id: &str) -> Option<String> {
        // 本机会话读档案里的显示名；远程会话的档案在那台 Host 上，不为一个提示条跨机读。
        match self.origin(session_id) {
            Some(None) => aide_core::session_store::our_session_name(session_id),
            _ => None,
        }
    }
}

/// 在 setup 里调用：启动执行器（自带专用线程与守护线程）。
pub fn manage(app: &AppHandle) {
    let hooks = Arc::new(DesktopComputerHooks { app: app.clone(), origins: Mutex::new(HashMap::new()) });
    let computer = Computer::start(hooks.clone());
    app.manage(ComputerState { computer, hooks });
}

fn state(app: &AppHandle) -> Option<&ComputerState> {
    app.try_state::<ComputerState>().map(|s| s.inner())
}

async fn answer(app: &AppHandle, req: Request, origin: Option<HostId>) -> Value {
    let Some(st) = state(app) else {
        return aide_computer::protocol::result_command(
            &req.request_id,
            aide_computer::protocol::err_payload("Computer use is not available in this Aide instance."),
        );
    };
    st.hooks.note_origin(&req.session_id, origin);
    let computer = st.computer.clone();
    let request_id = req.request_id.clone();
    // 执行器会阻塞（等待最长 60 s）：放进 blocking 池，不占 tokio 核心线程。
    match tokio::task::spawn_blocking(move || computer.answer_blocking(req)).await {
        Ok(v) => v,
        Err(e) => aide_computer::protocol::result_command(
            &request_id,
            aide_computer::protocol::err_payload(format!("The computer-use executor panicked: {e}")),
        ),
    }
}

/// 本机 Host：runtime 钩子拦到 `computer_query` 就执行并写回 stdin。返回 `true` = 是本桥事件。
pub fn intercept_local(app: &AppHandle, event: &Value, stdin: &aide_core::runtime::ports::AgentStdin) -> bool {
    let Some(req) = aide_computer::parse_request(event) else {
        return false;
    };
    let app = app.clone();
    let stdin = Arc::clone(stdin);
    tokio::spawn(async move {
        let payload = answer(&app, req, None).await;
        if let Ok(mut line) = serde_json::to_string(&payload) {
            line.push('\n');
            let mut guard = stdin.lock().await;
            let _ = guard.write_all(line.as_bytes()).await;
        }
    });
    true
}

/// 远程 Host：Host 事件里拦到 `computer_query` 就执行，回包经 `agent_tool_result` 回到那台 Host。
pub fn intercept_remote(app: &AppHandle, host: &HostId, event: &Value) -> bool {
    let Some(req) = aide_computer::parse_request(event) else {
        return false;
    };
    let app = app.clone();
    let host = host.clone();
    tauri::async_runtime::spawn(async move {
        let payload = answer(&app, req, Some(host.clone())).await;
        let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
        let sent = async { svc.connection(&host).await?.invoke("agent_tool_result", json!({ "payload": payload })).await }.await;
        if let Err(e) = sent {
            tracing::warn!(host = %host, "computer query reply failed: {e}");
        }
    });
    true
}

/// 每条 chat-event 都过一遍：用户新消息解除「接管暂停」，一轮结束放锁。
pub fn observe(app: &AppHandle, event: &Value) {
    if let Some(st) = state(app) {
        st.computer.observe_event(event);
    }
}
