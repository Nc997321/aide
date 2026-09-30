//! 「一个窗口 = 一个 Host」的桌面侧：窗口 ↔ Host 绑定、开 Host 窗口、按窗口投递事件。
//!
//! - **主窗口**（`main`）连本机 Host（进程内 aide-core，见 `host_door`）。
//! - **Host 窗口**（`host-…`）连一台目标机上的 `aide-host serve`：它的 core 命令由
//!   `host_door::forward` 原样转发（Host 原生路径，不翻译），serve 的事件只投给它自己。
//! - 事件隔离两头都要：后端对 Host 事件一律 `emit_to(窗口)`，前端监听一律窗口作用域
//!   （`@aide/sdk` 的 TauriTransport）——Tauri 的全局 `listen` 会收到发给任何窗口的事件。
//!
//! 设计见 docs/host-model.md。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};

use crate::remote_workspace::path::HostId;
use crate::remote_workspace::RemoteWorkspaces;

/// 窗口标签 → 它连着的远程 Host。不在表里 = 本机 Host（主窗口）。
#[derive(Default)]
pub struct HostWindows {
    map: Mutex<HashMap<String, HostId>>,
}

impl HostWindows {
    pub fn host_of(&self, label: &str) -> Option<HostId> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(label)
            .cloned()
    }

    fn bind(&self, label: &str, host: &HostId) {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(label.to_string(), host.clone());
    }

    /// 解绑，返回该 Host 是否已没有别的窗口（调用方据此断开连接）。
    fn unbind(&self, label: &str) -> Option<(HostId, bool)> {
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        let host = map.remove(label)?;
        let last = !map.values().any(|h| h == &host);
        Some((host, last))
    }

    fn windows_of(&self, host: &HostId) -> Vec<String> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(_, h)| *h == host)
            .map(|(l, _)| l.clone())
            .collect()
    }
}

/// 窗口标签：`host-` + 主机键（Tauri 标签只认字母数字与 `-/:_`，其余字符折成 `_`）。
fn label_for(host: &HostId) -> String {
    let key: String = host
        .key()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    format!("host-{key}")
}

/// 本机 Host（进程内 core）的事件：只投给没绑远程 Host 的窗口。
pub fn emit_local(app: &AppHandle, event: &str, payload: &Value) {
    let windows = app.state::<HostWindows>();
    for (label, _) in app.webview_windows() {
        if windows.host_of(&label).is_none() {
            if let Err(e) = app.emit_to(EventTarget::webview_window(&label), event, payload) {
                tracing::warn!(event, window = %label, "core event emit failed: {e}");
            }
        }
    }
}

/// 远程 Host 的事件（serve 的通知帧）：只投给连着这台 Host 的窗口，事件名 / payload 原样。
pub fn emit_to_host(app: &AppHandle, host: &HostId, event: &str, payload: &Value) {
    for label in app.state::<HostWindows>().windows_of(host) {
        if let Err(e) = app.emit_to(EventTarget::webview_window(&label), event, payload) {
            tracing::warn!(event, window = %label, "host event emit failed: {e}");
        }
    }
}

/// 该 Host 当前是否有窗口连着（旧模型的桌面形态事件翻译据此让路，P1d 删除）。
pub fn has_windows(app: &AppHandle, host: &HostId) -> bool {
    !app.state::<HostWindows>().windows_of(host).is_empty()
}

/// 窗口关闭：解绑；该 Host 的最后一扇窗关了就断开连接（serve 退出，Host 上的 agent runtime /
/// 语言服务器随之收掉）。
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    let Some((host, last)) = app.state::<HostWindows>().unbind(label) else {
        return;
    };
    if last {
        let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
        tauri::async_runtime::spawn(async move { svc.disconnect(&host).await });
    }
}

/// 打开（或聚焦）连着某台 Host 的窗口。连接 / 首次安装在后台开始，窗口里的第一批命令会
/// 等它就绪；进度经 `remote-workspace-status` 事件可见。
#[tauri::command]
pub async fn open_host_window(app: AppHandle, host: String) -> Result<String, String> {
    let id = HostId::parse_key(&host).ok_or_else(|| format!("非法主机标识：{host}"))?;
    let label = label_for(&id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(label);
    }
    // 先绑定再建窗：窗口一加载就可能发命令，那时绑定必须已在。
    app.state::<HostWindows>().bind(&label, &id);
    let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
    {
        let id = id.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = svc.connection(&id).await {
                tracing::warn!(host = %id, "host window connect failed: {e}");
            }
        });
    }
    let built = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(format!("Aide — {}", id.label()))
    .inner_size(1400.0, 900.0)
    .min_inner_size(900.0, 600.0)
    .center()
    .decorations(false)
    .visible(true)
    .disable_drag_drop_handler()
    .build();
    match built {
        Ok(w) => {
            crate::style_window(&w);
            Ok(label)
        }
        Err(e) => {
            app.state::<HostWindows>().unbind(&label);
            Err(format!("无法打开 {} 窗口：{e}", id.label()))
        }
    }
}

/// 调用方窗口连着哪台 Host（前端据此显示 Host 标签、选路径语义）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentHost {
    /// `local` / `wsl:Debian` / `ssh:devbox`
    pub key: String,
    /// 显示名：`本机` / `WSL: Debian` / `SSH: devbox`
    pub label: String,
    /// Host 的操作系统（`windows` / `linux` / `macos`）——路径语义跟它走，不跟 GUI 所在系统。
    pub os: String,
    /// Host 上的家目录（Host 原生路径）；连接未就绪时为空。
    pub home: String,
}

#[tauri::command]
pub async fn current_host(window: WebviewWindow) -> Result<CurrentHost, String> {
    let app = window.app_handle();
    match app.state::<HostWindows>().host_of(window.label()) {
        None => Ok(CurrentHost {
            key: "local".into(),
            label: "本机".into(),
            os: std::env::consts::OS.into(),
            home: aide_core::paths::user_home()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }),
        Some(host) => {
            let svc = app.state::<Arc<RemoteWorkspaces>>().inner().clone();
            let conn = svc.connection(&host).await?;
            Ok(CurrentHost {
                key: host.key(),
                label: host.label(),
                os: conn.info.os.clone(),
                home: conn.info.home.clone(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_tauri_safe_and_distinct() {
        assert_eq!(label_for(&HostId::Wsl("Debian".into())), "host-wsl_Debian");
        assert_eq!(label_for(&HostId::Ssh("dev.box@x".into())), "host-ssh_dev_box_x");
    }

    #[test]
    fn last_window_of_a_host_is_reported() {
        let w = HostWindows::default();
        let h = HostId::Wsl("Debian".into());
        w.bind("host-a", &h);
        w.bind("host-b", &h);
        assert_eq!(w.unbind("host-a"), Some((h.clone(), false)));
        assert_eq!(w.unbind("host-b"), Some((h, true)));
        assert_eq!(w.unbind("host-b"), None);
    }
}
