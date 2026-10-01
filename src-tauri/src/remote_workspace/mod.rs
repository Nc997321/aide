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

use aide_host::protocol::{Notification, Resume};
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
    /// connecting | installing | connected | error | disconnected | reconnecting | resync
    ///
    /// - `reconnecting`：连接断了，正在凭序号重连（Host 上的会话还在）
    /// - `resync`：重连上了原来的 Host，但断线太久、错过的事件已被覆盖——会话仍在，界面需要重新加载
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
    /// 连接**意外断开**的 Host → 断开原因。在表里 = 等用户显式重连：[`connection`](Self::connection)
    /// 拒绝懒重连（重连 = 全新的 serve，Host 上进行中的会话早已随旧 serve 收掉，静默重连会让
    /// 用户以为会话还在），只有 [`connect`](Self::connect) 与 [`disconnect`](Self::disconnect) 清它。
    dropped: Mutex<HashMap<HostId, String>>,
    /// 正在自动重连的 Host（连接断了、守护进程仍可能在）。在表里时 [`connection`](Self::connection)
    /// 如实回「正在重新连接」，不另起一条会跟重连抢的连接；`connect` / `disconnect` 清它（=取消）。
    reconnecting: Mutex<std::collections::HashSet<HostId>>,
}

/// 断线重连的退避（秒）：覆盖一次 ssh 网络抖动 / WSL 重启，之后放弃并如实报断开。
const RESUME_BACKOFF_SECS: &[u64] = &[1, 2, 4, 8, 15, 30, 30];

/// 连接断开后的去向（[`RemoteWorkspaces::on_closed`] 的结论）。
pub enum Closed {
    /// 不是登记在册的那条（主动断开 / 已被替换）：什么都不做。
    Ignored,
    /// 无法恢复（连的不是守护进程）：已标记断开，窗口需要收尾。
    Dropped,
    /// 守护进程可能还在：凭这个重连。
    Resumable(Resume),
}

/// 一轮自动重连的结局。
pub enum Resumed {
    /// 接上了原来的 Host，事件无缝补齐：界面什么都不用做。
    Seamless,
    /// 接上了原来的 Host，但错过的事件已丢：会话在，界面需要重新加载（状态条提示）。
    Resync,
    /// 被取消（用户主动断开 / 显式重连接管）。
    Cancelled,
    /// 没接上原来的 Host（守护进程重启过 / 一直连不上）：会话已没，附原因。
    Lost(String),
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

    /// 取（必要时建立）到目标机的连接。首次会安装远程套件。**意外断开的 Host 不在这里重连**
    /// （见 `dropped`）：如实报断开，由用户经 [`connect`](Self::connect) 显式重连。
    pub async fn connection(&self, host: &HostId) -> Result<Arc<HostConnection>, String> {
        if let Some(c) = self.conns.lock().await.get(host) {
            if c.is_alive() {
                return Ok(Arc::clone(c));
            }
        }
        if self.is_reconnecting(host) {
            return Err(format!("与 {} 的连接已断开，正在重新连接…", host.label()));
        }
        if let Some(reason) = self.dropped_reason(host) {
            return Err(format!("{reason}。请重新连接"));
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
        match self.establish(host, None).await {
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

    /// 用户显式（重新）连接：清掉「已断开」标记，丢掉死连接，走完整的建连流程。
    pub async fn connect(&self, host: &HostId) -> Result<Arc<HostConnection>, String> {
        self.dropped.lock().unwrap_or_else(PoisonError::into_inner).remove(host);
        self.reconnecting.lock().unwrap_or_else(PoisonError::into_inner).remove(host);
        let stale = self.conns.lock().await.remove(host);
        drop(stale);
        self.connection(host).await
    }

    fn is_reconnecting(&self, host: &HostId) -> bool {
        self.reconnecting.lock().unwrap_or_else(PoisonError::into_inner).contains(host)
    }

    fn mark_dropped(&self, host: &HostId, reason: &str) {
        self.dropped
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(host.clone(), reason.to_string());
        self.set_status(host, "disconnected", Some(reason.to_string()), None);
    }

    fn dropped_reason(&self, host: &HostId) -> Option<String> {
        self.dropped.lock().unwrap_or_else(PoisonError::into_inner).get(host).cloned()
    }

    /// 连接的子进程退出。**只有「它仍是登记在册的那条、且确已死」才算意外断开**：用户主动
    /// `disconnect`（连接已被摘掉）与已被新连接替换的旧连接都不算。
    ///
    /// 连的是守护进程（带得出重连凭据）→ 转入「重连中」，由调用方跑 [`resume`](Self::resume)；
    /// 否则直接标成已断开（需要用户显式重连）。
    pub async fn on_closed(&self, host: &HostId, reason: &str) -> Closed {
        let conn = self.conns.lock().await.get(host).cloned();
        let Some(conn) = conn.filter(|c| !c.is_alive()) else {
            return Closed::Ignored;
        };
        if let Some(token) = conn.resume_token() {
            self.reconnecting.lock().unwrap_or_else(PoisonError::into_inner).insert(host.clone());
            self.set_status(host, "reconnecting", Some(reason.to_string()), None);
            return Closed::Resumable(token);
        }
        self.mark_dropped(host, reason);
        Closed::Dropped
    }

    /// 自动重连：退避重试，凭 `token` 接回原来的守护进程。结局见 [`Resumed`]。
    /// 期间 [`connection`](Self::connection) 如实拒绝新请求（见 `reconnecting`）。
    pub async fn resume(&self, host: &HostId, token: Resume) -> Resumed {
        let mut last_err = String::new();
        for secs in RESUME_BACKOFF_SECS {
            tokio::time::sleep(std::time::Duration::from_secs(*secs)).await;
            if !self.is_reconnecting(host) {
                return Resumed::Cancelled;
            }
            match self.establish(host, Some(token.clone())).await {
                Ok(c) => {
                    // 建连途中用户可能已显式断开 / 重连：别再把这条塞进去
                    if !self.is_reconnecting(host) {
                        return Resumed::Cancelled;
                    }
                    let attach = c.attach_info().cloned();
                    match attach {
                        Some(a) if a.resumed => {
                            self.conns.lock().await.insert(host.clone(), Arc::clone(&c));
                            self.reconnecting.lock().unwrap_or_else(PoisonError::into_inner).remove(host);
                            if a.gap {
                                self.set_status(
                                    host,
                                    "resync",
                                    Some("断线期间错过的更新太多，已无法补齐".into()),
                                    Some(c.info.home.clone()),
                                );
                                return Resumed::Resync;
                            }
                            tracing::info!(host = %host, replayed = a.replayed, "resumed Host connection");
                            self.set_status(host, "connected", None, Some(c.info.home.clone()));
                            return Resumed::Seamless;
                        }
                        // 接上的是另一个守护进程（Host 重启过）：旧会话已不存在，这条新连接
                        // 也不要——用户显式重连时再从头建。
                        _ => {
                            self.reconnecting.lock().unwrap_or_else(PoisonError::into_inner).remove(host);
                            let reason = format!("{} 已重启，进行中的会话已终止", host.label());
                            self.mark_dropped(host, &reason);
                            return Resumed::Lost(reason);
                        }
                    }
                }
                Err(e) => {
                    tracing::info!(host = %host, "resume attempt failed: {e}");
                    last_err = e;
                }
            }
        }
        self.reconnecting.lock().unwrap_or_else(PoisonError::into_inner).remove(host);
        let reason = format!("无法重新连接 {}：{last_err}", host.label());
        self.mark_dropped(host, &reason);
        Resumed::Lost(reason)
    }

    async fn establish(&self, host: &HostId, resume: Option<Resume>) -> Result<Arc<HostConnection>, String> {
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
            resume,
            subscribe: None,
        };
        let app_for_events = app.clone();
        let app_for_close = app.clone();
        HostConnection::start(
            host.clone(),
            cmd,
            &init,
            Arc::new(move |h: &HostId, n: Notification| on_host_event(&app_for_events, h, n)),
            Arc::new(move |h: &HostId, reason: &str| on_host_closed(&app_for_close, h, reason)),
        )
        .await
    }

    pub async fn disconnect(&self, host: &HostId) {
        self.dropped.lock().unwrap_or_else(PoisonError::into_inner).remove(host);
        self.reconnecting.lock().unwrap_or_else(PoisonError::into_inner).remove(host);
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

/// serve（桥）的子进程退出。守护进程在 → 凭序号自动重连，成功则界面无感；否则（连的不是
/// 守护进程 / Host 重启过 / 一直连不上）如实标成断开，并告诉这台 Host 的窗口——会话随 Host
/// 一起没了，不会再有 `session_dead` 来收掉正忙的会话，前端靠 `runtime_dead` 这一帧收尾。
fn on_host_closed(app: &AppHandle, host: &HostId, reason: &str) {
    let app = app.clone();
    let host = host.clone();
    let reason = reason.to_string();
    tauri::async_runtime::spawn(async move {
        let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
        let lost = match svc.on_closed(&host, &reason).await {
            Closed::Ignored => None,
            Closed::Dropped => Some(reason),
            Closed::Resumable(token) => match svc.resume(&host, token).await {
                Resumed::Lost(why) => Some(why),
                Resumed::Seamless | Resumed::Resync | Resumed::Cancelled => None,
            },
        };
        if let Some(detail) = lost {
            let payload = serde_json::json!({
                "type": "runtime_dead",
                "reason": "host_disconnected",
                "detail": detail,
            });
            crate::host_window::emit_to_host(&app, &host, "chat-event", &payload);
        }
    });
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
    // 显式连接 = 也是「重新连接」的入口：清掉断开标记、丢掉死连接，从头建一条。
    let c = svc.connect(&id).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 意外断开的 Host：`connection()` 拒绝静默重连并给出原因；显式 `connect()` 清掉标记、
    /// 走到真正的建连（测试里没有 AppHandle，所以停在「未挂载」——证明过了闸门）。
    #[tokio::test]
    async fn dropped_host_is_not_reconnected_silently() {
        let ws = RemoteWorkspaces::default();
        let host = HostId::Wsl("Debian".into());
        ws.dropped
            .lock()
            .unwrap()
            .insert(host.clone(), "与 WSL: Debian 的连接已断开".into());

        let err = ws.connection(&host).await.err().unwrap();
        assert!(err.contains("已断开") && err.contains("请重新连接"), "{err}");
        // 反复调用也不会悄悄重连
        assert!(ws.connection(&host).await.err().unwrap().contains("请重新连接"));

        let err = ws.connect(&host).await.err().unwrap();
        assert!(err.contains("not attached"), "explicit connect must pass the gate: {err}");
        assert!(ws.dropped_reason(&host).is_none(), "explicit connect clears the mark");
    }

    /// 自动重连期间：新请求如实回「正在重新连接」（不另起一条会跟重连抢的连接）；用户显式
    /// 重连 / 断开 = 取消这轮自动重连。
    #[tokio::test]
    async fn requests_during_auto_reconnect_wait_and_explicit_actions_cancel_it() {
        let ws = RemoteWorkspaces::default();
        let host = HostId::Wsl("Debian".into());
        ws.reconnecting.lock().unwrap().insert(host.clone());

        let err = ws.connection(&host).await.err().unwrap();
        assert!(err.contains("正在重新连接"), "{err}");
        assert!(ws.is_reconnecting(&host));

        // 显式重连接管：清掉「重连中」（之后停在「未挂载」= 过了闸门）
        let err = ws.connect(&host).await.err().unwrap();
        assert!(err.contains("not attached"), "{err}");
        assert!(!ws.is_reconnecting(&host));

        ws.reconnecting.lock().unwrap().insert(host.clone());
        ws.disconnect(&host).await;
        assert!(!ws.is_reconnecting(&host));
    }

    /// 重连被取消后，`resume` 在下一次醒来就收手，不去碰已经由别人接管的连接。
    #[tokio::test]
    async fn resume_stops_when_cancelled() {
        let ws = RemoteWorkspaces::default();
        let host = HostId::Wsl("Debian".into());
        // 不在「重连中」表里 = 已被取消
        let out = ws.resume(&host, Resume { daemon_id: "d".into(), seq: 1 }).await;
        assert!(matches!(out, Resumed::Cancelled));
    }

    /// 用户主动断开 = 一次干净的重新开始：断开标记一并清掉。
    #[tokio::test]
    async fn disconnect_clears_the_dropped_mark() {
        let ws = RemoteWorkspaces::default();
        let host = HostId::Wsl("Debian".into());
        ws.dropped.lock().unwrap().insert(host.clone(), "x".into());
        ws.disconnect(&host).await;
        assert!(ws.dropped_reason(&host).is_none());
    }

    /// 连接已被摘掉（主动断开）后迟到的 EOF 回调，不能被当成意外断开。
    #[tokio::test]
    async fn on_closed_ignores_connections_that_are_no_longer_registered() {
        let ws = RemoteWorkspaces::default();
        let host = HostId::Wsl("Debian".into());
        assert!(matches!(ws.on_closed(&host, "late EOF").await, Closed::Ignored));
        assert!(ws.dropped_reason(&host).is_none());
    }
}
