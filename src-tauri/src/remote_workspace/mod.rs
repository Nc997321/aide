//! 远程工作区：GUI 留在桌面，工作区住在没有图形界面的目标机上（WSL 发行版 / SSH 服务器）。
//!
//! 与 `crate::remote`（手机远程**控制**桌面）是两回事：那边是别的设备操作这台桌面，
//! 这边是这台桌面操作别的机器上的工作区。
//!
//! 结构：
//! - [`path`]：桌面侧远程路径形态（`\\wsl.localhost\<distro>\…` / `\\aide-ssh.invalid\<alias>\…`）
//!   ↔ 目标机 POSIX 路径。唯一真相源。
//! - [`launcher`]：进到目标机的一跳（`wsl.exe` / `ssh`），对上层同构。
//! - [`install`]：远程套件（aide-host + sidecar + Claude CLI）按版本哈希幂等安装。
//! - [`connection`]：与目标机 `aide-host serve` 的 JSON-RPC 长连接。
//! - [`routes`]：IPC 拦截层——参数里带远程路径的工作区命令转发给 aide-host，在目标机上
//!   跑与桌面**同一份**实现（crates/aide-workspace）；不支持的命令大声拒绝，绝不回落本机。
//! - agent：会话按工作区归属分「车道」，见 `crate::runtime`（lane）。
//!
//! 设计取舍见 docs/remote-workspaces.md。

pub mod connection;
pub mod install;
pub mod launcher;
pub mod lsp_pipe;
pub mod path;
pub mod routes;
pub mod sessions;

#[cfg(all(test, windows))]
mod e2e_tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use aide_host::protocol::{Notification, WatchParams, METHOD_WATCH};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as TokioMutex;

use connection::HostConnection;
use install::Installed;
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
    /// 目标机家目录（桌面形态），连接成功后才有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

#[derive(Default)]
pub struct RemoteWorkspaces {
    app: OnceLock<AppHandle>,
    conns: TokioMutex<HashMap<HostId, Arc<HostConnection>>>,
    /// 按主机的建连单飞锁：并发的首个请求只触发一次安装 + 握手。
    connecting: Mutex<HashMap<HostId, Arc<TokioMutex<()>>>>,
    installed: Mutex<HashMap<HostId, Installed>>,
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

    /// 已安装套件信息（agent 车道启动需要）；未安装则先安装。
    pub async fn installed(&self, host: &HostId) -> Result<Installed, String> {
        if let Some(i) = self
            .installed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(host)
            .cloned()
        {
            return Ok(i);
        }
        self.connection(host).await?;
        self.installed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(host)
            .cloned()
            .ok_or_else(|| format!("{} 套件未安装", host.label()))
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
                let home = path::to_desktop(host, &c.info.home);
                self.set_status(host, "connected", None, Some(home));
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
        self.installed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(host.clone(), inst.clone());
        self.set_status(host, "connecting", None, None);
        let cmd = launcher::command(
            host,
            &format!("exec {} serve", launcher::sh_quote(&inst.host_bin)),
        )?;
        let app_for_events = app.clone();
        HostConnection::start(
            host.clone(),
            cmd,
            Arc::new(move |h: &HostId, n: Notification| on_host_event(&app_for_events, h, n)),
        )
        .await
    }

    /// 文件树监听：远程根交给对应主机；其余已连主机一律停表（前端同一时刻只有一棵树）。
    pub async fn retarget_watch(&self, root: Option<(HostId, String)>) -> Result<(), String> {
        let conns: Vec<Arc<HostConnection>> = self.conns.lock().await.values().cloned().collect();
        for c in conns {
            let wanted = root.as_ref().filter(|(h, _)| h == &c.host).map(|(_, p)| p.clone());
            if wanted.is_none() && !c.is_alive() {
                continue;
            }
            let params = serde_json::to_value(WatchParams { root: wanted.clone() })
                .map_err(|e| e.to_string())?;
            if let Err(e) = c.call(METHOD_WATCH, params).await {
                if wanted.is_some() {
                    return Err(e);
                }
            }
        }
        if let Some((host, p)) = root {
            // 该主机尚未建连（上面没遍历到）：建连后再下发
            let c = self.connection(&host).await?;
            let params = serde_json::to_value(WatchParams { root: Some(p) }).map_err(|e| e.to_string())?;
            c.call(METHOD_WATCH, params).await?;
        }
        Ok(())
    }

    pub async fn disconnect(&self, host: &HostId) {
        self.conns.lock().await.remove(host);
        self.set_status(host, "disconnected", None, None);
    }
}

/// host 通知 → 桌面事件（路径译回桌面形态后照原事件名 emit，前端无感）。
fn on_host_event(app: &AppHandle, host: &HostId, n: Notification) {
    match n.event.as_str() {
        crate::filewatch::EVENT_NAME => {
            let dirs: Vec<String> = serde_json::from_value::<Vec<String>>(n.payload)
                .unwrap_or_default()
                .into_iter()
                .map(|d| path::to_desktop(host, &d))
                .collect();
            let _ = app.emit(crate::filewatch::EVENT_NAME, dirs);
        }
        other => tracing::debug!(host = %host, "unhandled aide-host event {other}"),
    }
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

/// 连接（必要时安装）目标机，返回其状态（含桌面形态的家目录，供目录选择器起步）。
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
        home: Some(path::to_desktop(&id, &c.info.home)),
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

/// 路径属于哪台目标机（前端据此显示徽标、选择终端 / 禁用本机专属功能）。本机路径 → None。
#[tauri::command]
pub fn remote_ws_host_of(path: String) -> Option<HostStatus> {
    path::parse(&path).map(|(h, _)| HostStatus {
        host: h.key(),
        label: h.label(),
        state: String::new(),
        detail: None,
        home: None,
    })
}

pub fn manage(app: &tauri::App) {
    let svc = Arc::new(RemoteWorkspaces::default());
    svc.attach(app.handle().clone());
    app.manage(svc);
}
