//! 设置命令的桌面侧：设置本体与 state.json 住在 aide-core（`aide_core::app_settings`，
//! 这里整体 re-export 保持既有调用路径）；本文件只剩 GUI 能力（系统通知）与尚未迁入
//! core 的 codegraph / 会话路由查询。

use serde::Serialize;
use tauri::State;

pub use aide_core::app_settings::*;
use crate::settings::SettingsService;

// 代码索引开关已是工作区级（`commands::workspace::codegraph_workspaces`，
// 每工作区默认关），全局 settings 字段已删除——本文件只剩 embedder 配置职责。
pub(crate) fn resolve_codegraph_embedder(
    service: &SettingsService,
) -> Result<RuntimeCodeGraphEmbedderConfig, String> {
    let settings = public_settings(service)?;
    Ok(RuntimeCodeGraphEmbedderConfig {
        backend: settings.codegraph_embedder.backend,
        base_url: settings.codegraph_embedder.base_url,
        api_key: service
            .secrets()
            .get("codegraph/default/apiKey")
            .map_err(|error| error.to_string())?
            .unwrap_or_default(),
        model: settings.codegraph_embedder.model,
        format: settings.codegraph_embedder.format,
        dim: settings.codegraph_embedder.dim,
        score_threshold: settings.codegraph_embedder.score_threshold,
    })
}

/// 运行时 embedder 配置 DTO。**数据唯一主人在 codegraph-core**（主进程与
/// codegraph-runner 进程共用同一份定义——它跨进程边界序列化传输）。
pub(crate) use codegraph_core::RuntimeCodeGraphEmbedderConfig;

/// Send a desktop notification with the correct AppUserModelID,
/// bypassing the notification plugin's dev-mode skip.
///
/// Windows 点击定位（QQ/微信式）：notify-rust 的 Windows 后端根本没接
/// on_activated（点了没反应），这里直接用底层 tauri-winrt-notification 接
/// 激活回调。点击 toast → 进程内 Activated 事件 → 聚焦主窗口 + emit
/// open-session-from-notification（带 session_id），前端据此打开会话。
/// 其他平台维持 notify-rust（macOS 系统级自带激活行为，Linux 各发行版不一）。
#[tauri::command]
pub fn notify_send(app: tauri::AppHandle, title: String, body: String, session_id: Option<String>) {
    let _trace = crate::diagnostics::trace_command("notify_send");

    #[cfg(windows)]
    {
        use tauri::{Emitter, Manager};
        let toast = tauri_winrt_notification::Toast::new("com.aide.app")
            .title(&title)
            .text2(&body)
            .on_activated(move |_args| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                if let Some(ref id) = session_id {
                    let _ = app.emit("open-session-from-notification", id.clone());
                }
                Ok(())
            });
        // 激活回调挂在 toast 对象上，show 失败静默（通知是增强体验，不阻断主流程）
        let _ = toast.show();
    }

    #[cfg(not(windows))]
    {
        let _ = (app, session_id);
        let mut n = notify_rust::Notification::new();
        n.app_id("com.aide.app");
        n.auto_icon();
        n.summary(&title);
        n.body(&body);
        tauri::async_runtime::spawn(async move {
            let _ = n.show();
        });
    }
}

/// 桌面通知的会话上下文：按 session_id 查它**真实所属的工作区**（send_message
/// 注册的进程内路由表）+ 会话显示名。会话是内存形态——进程死了 claude cli 也
/// 随之关闭，不存在重启后还要通知的会话，因此路由表即权威、无需落盘兜底。
/// 查不到路由（如新会话 finalize 换 key 后尚未再 send）返回 None，前端回退
/// 当前工作区名。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotificationInfo {
    /// 会话所属工作区根路径
    pub workspace: String,
    /// 会话显示名（our_session_name 权威源，缺失回退 session id）
    pub name: String,
}

#[tauri::command]
pub fn session_notification_info(
    session_id: String,
    runtime_mgr: State<'_, crate::runtime::AgentRuntimeManager>,
) -> Option<SessionNotificationInfo> {
    let workspace = runtime_mgr.session_workspace_root(&session_id)?;
    let name = super::our_session_name(&session_id).unwrap_or(session_id);
    Some(SessionNotificationInfo {
        workspace: workspace.to_string_lossy().to_string(),
        name,
    })
}

