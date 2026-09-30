//! 远程 Host 的连接：一扇 Host 窗口连着一台目标机（WSL 发行版 / SSH 服务器）上的
//! `aide-host serve`——那就是一个完整的 Aide 后端（Host 模型，见 docs/host-model.md）。
//!
//! 与 `crate::remote`（手机远程**控制**桌面）是两回事。
//!
//! 结构：
//! - [`path`]：主机标识 [`HostId`] 与 WSL 路径的桌面形态（`\\wsl.localhost\<distro>\…`，只用于
//!   「用本机程序打开 / 在资源管理器中显示」这类显式跨界的 GUI 动作）。
//! - [`launcher`]：进到目标机的一跳（`wsl.exe` / `ssh`），对上层同构。
//! - [`install`]：远程套件（aide-host + sidecar + Claude CLI）按版本哈希幂等安装；Host 进程环境。
//! - [`connection`]：与目标机 `aide-host serve` 的 JSON-RPC 长连接（请求-响应 + 事件通知）。
//!
//! 窗口 ↔ Host 绑定、命令转发与事件投递在 `crate::host_window` / `crate::host_door`。

pub mod connection;
pub mod install;
pub mod launcher;
pub mod path;

#[cfg(all(test, windows))]
mod e2e_tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use aide_host::protocol::Notification;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as TokioMutex;

use connection::HostConnection;
use path::HostId;

/// 连接状态变化事件（前端状态栏 / 连接对话框订阅）。
pub const STATUS_EVENT: &str = "remote-workspace-status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub host: String,
    pub label: String,
    /// connecting | installing | connected | error | disconnected
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 目标机家目录（Host 原生路径），连接成功后才有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

#[derive(Default)]
pub struct RemoteWorkspaces {
    app: OnceLock<AppHandle>,
    conns: TokioMutex<HashMap<HostId, Arc<HostConnection>>>,
    /// 按主机的建连单飞锁：并发的首个请求只触发一次安装 + 握手。
    connecting: Mutex<HashMap<HostId, Arc<TokioMutex<()>>>>,
    status: Mutex<HashMap<HostId, HostStatus>>,
}

impl RemoteWorkspaces {
    pub fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    fn app(&self) -> Result<&AppHandle, String> {
        self.app.get().ok_or_else(|| "remote workspaces not attached".to_string())
    }

    fn set_status(&self, host: &HostId, state: &str, detail: Option<String>, home: Option<String>) {
        let s = HostStatus {
            host: host.key(),
            label: host.label(),
            state: state.to_string(),
            detail,
            home,
        };
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(host.clone(), s.clone());
        if let Ok(app) = self.app() {
            let _ = app.emit(STATUS_EVENT, s);
        }
    }

    pub fn statuses(&self) -> Vec<HostStatus> {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect()
    }

    /// 取（必要时建立）到目标机的连接。首次会安装远程套件。
    pub async fn connection(&self, host: &HostId) -> Result<Arc<HostConnection>, String> {
        if let Some(c) = self.conns.lock().await.get(host) {
            if c.is_alive() {
                return Ok(Arc::clone(c));
            }
        }
        let gate = {
            let mut m = self.connecting.lock().unwrap_or_else(PoisonError::into_inner);
            Arc::clone(m.entry(host.clone()).or_default())
        };
        let _guard = gate.lock().await;
        // 单飞：拿到锁时别人可能已经连好了
        if let Some(c) = self.conns.lock().await.get(host) {
            if c.is_alive() {
                return Ok(Arc::clone(c));
            }
        }
        match self.establish(host).await {
            Ok(c) => {
                self.set_status(host, "connected", None, Some(c.info.home.clone()));
                self.conns.lock().await.insert(host.clone(), Arc::clone(&c));
                Ok(c)
            }
            Err(e) => {
                self.set_status(host, "error", Some(e.clone()), None);
                Err(e)
            }
        }
    }

    async fn establish(&self, host: &HostId) -> Result<Arc<HostConnection>, String> {
        let app = self.app()?.clone();
        self.set_status(host, "installing", None, None);
        let inst = install::ensure_installed(install::kit_dirs(&app), host).await?;
        self.set_status(host, "connecting", None, None);
        let cmd = launcher::command(
            host,
            &format!("exec {} serve", launcher::sh_quote(&inst.host_bin)),
        )?;
        let host_env = install::host_env(host, &inst).await;
        let init = aide_host::protocol::ServeInit {
            env: host_env.env,
            default_env: host_env.default_env,
            node: inst.node.clone(),
            claude_exe: Some(inst.claude_exe.clone()),
        };
        let app_for_events = app.clone();
        HostConnection::start(
            host.clone(),
            cmd,
            &init,
            Arc::new(move |h: &HostId, n: Notification| on_host_event(&app_for_events, h, n)),
        )
        .await
    }

    pub async fn disconnect(&self, host: &HostId) {
        self.conns.lock().await.remove(host);
        self.set_status(host, "disconnected", None, None);
    }
}

/// serve 的通知帧（Host 核心经 `EventSink` 发出的事件）→ 只投给连着这台 Host 的窗口，
/// 事件名 / payload 原样（Host 原生路径，前端无需翻译）。
fn on_host_event(app: &AppHandle, host: &HostId, n: Notification) {
    // Host 的 agent 要用内嵌浏览器（GUI 能力）：不转给前端，由桌面应答后经
    // `agent_tool_result` 回到那台 Host 的 runtime。
    if n.event == "chat-event" {
        if let Some(req) = crate::browser::agent_bridge::parse_browser_query(&n.payload) {
            crate::host_window::answer_browser_query(app, host, req);
            return;
        }
    }
    crate::host_window::emit_to_host(app, host, &n.event, &n.payload);
}

// ── Tauri 命令（连接管理 UI） ─────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTargets {
    pub wsl: Vec<String>,
    pub ssh: Vec<String>,
}

/// 可连接的目标：本机 WSL 发行版 + `~/.ssh/config` 的 Host 别名。
#[tauri::command]
pub async fn remote_ws_targets() -> Result<RemoteTargets, String> {
    let wsl = launcher::list_wsl_distros().await.unwrap_or_else(|e| {
        tracing::info!("list wsl distros: {e}");
        Vec::new()
    });
    let ssh = tokio::task::spawn_blocking(launcher::list_ssh_config_hosts)
        .await
        .map_err(|e| e.to_string())?;
    Ok(RemoteTargets { wsl, ssh })
}

/// 连接（必要时安装）目标机，返回其状态（含 Host 上的家目录）。
#[tauri::command]
pub async fn remote_ws_connect(
    host: String,
    svc: tauri::State<'_, Arc<RemoteWorkspaces>>,
) -> Result<HostStatus, String> {
    let id = HostId::parse_key(&host).ok_or_else(|| format!("非法主机标识：{host}"))?;
    let c = svc.connection(&id).await?;
    Ok(HostStatus {
        host: id.key(),
        label: id.label(),
        state: "connected".into(),
        detail: None,
        home: Some(c.info.home.clone()),
    })
}

#[tauri::command]
pub async fn remote_ws_disconnect(
    host: String,
    svc: tauri::State<'_, Arc<RemoteWorkspaces>>,
) -> Result<(), String> {
    let id = HostId::parse_key(&host).ok_or_else(|| format!("非法主机标识：{host}"))?;
    svc.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub fn remote_ws_statuses(svc: tauri::State<'_, Arc<RemoteWorkspaces>>) -> Vec<HostStatus> {
    svc.statuses()
}

pub fn manage(app: &tauri::App) {
    let svc = Arc::new(RemoteWorkspaces::default());
    svc.attach(app.handle().clone());
    app.manage(svc);
}
