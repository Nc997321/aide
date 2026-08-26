use serde_json::json;
use tauri::Manager;

use super::auth;
use super::protocol::{DesktopToPhone, PhoneToDesktop};
use super::{read_remote_settings, RemoteGateway};

/// 手机消息 → 可执行动作（纯函数，可单测）。
#[derive(Debug, Clone, PartialEq)]
pub enum BridgeAction {
    Pair { code: String },
    Auth { token: String },
    SendMessage { session_id: String, prompt: String, workspace_key: Option<String> },
    LoadMessages { session_id: String },
    ListSessions { workspace_key: Option<String> },
    ListWorkspaces,
}

/// 纯映射：认证检查 + 消息规范化（无 session_id 时生成 remote- 前缀 id）。
/// permission_mode 不在这里——执行时读设置（可中途改，每次执行生效）。
pub fn map_message(msg: &PhoneToDesktop, authed: bool) -> Result<BridgeAction, String> {
    match msg {
        PhoneToDesktop::Pair { code } => Ok(BridgeAction::Pair { code: code.clone() }),
        PhoneToDesktop::Auth { token } => Ok(BridgeAction::Auth { token: token.clone() }),
        PhoneToDesktop::SendMessage { session_id, prompt, workspace_key } => {
            if !authed { return Err("未认证：请先配对".into()); }
            let sid = session_id.clone()
                .unwrap_or_else(|| format!("remote-{}", auth::generate_device_id()));
            Ok(BridgeAction::SendMessage { session_id: sid, prompt: prompt.clone(), workspace_key: workspace_key.clone() })
        }
        PhoneToDesktop::LoadMessages { session_id } => {
            if !authed { return Err("未认证：请先配对".into()); }
            Ok(BridgeAction::LoadMessages { session_id: session_id.clone() })
        }
        PhoneToDesktop::ListSessions { workspace_key } => {
            if !authed { return Err("未认证：请先配对".into()); }
            Ok(BridgeAction::ListSessions { workspace_key: workspace_key.clone() })
        }
        PhoneToDesktop::ListWorkspaces => {
            if !authed { return Err("未认证：请先配对".into()); }
            Ok(BridgeAction::ListWorkspaces)
        }
    }
}

/// 执行动作（薄层：调现有 Tauri 命令 / 认证逻辑）。返回要回给手机的应答（None = 无应答）。
pub async fn execute(
    gateway: &std::sync::Arc<RemoteGateway>,
    action: BridgeAction,
) -> Result<Option<DesktopToPhone>, String> {
    match action {
        BridgeAction::Pair { code } => {
            if gateway.pairing.lock().unwrap().validate(&code) {
                let token = gateway.tokens.issue()?;
                let device_id = gateway.tokens.device_id().await?;
                Ok(Some(DesktopToPhone::PairOk { device_id, token }))
            } else {
                Ok(Some(DesktopToPhone::AuthError { message: "配对码无效或已过期".into() }))
            }
        }
        BridgeAction::Auth { token } => {
            if gateway.tokens.validate(&token) {
                Ok(Some(DesktopToPhone::AuthOk))
            } else {
                Ok(Some(DesktopToPhone::AuthError { message: "token 无效".into() }))
            }
        }
        BridgeAction::SendMessage { session_id, prompt, workspace_key } => {
            // 远程权限模式每次执行时读设置（可中途改，立即生效）
            let permission_mode = read_remote_settings(&gateway.app_handle).await?.permission_mode;
            let app = gateway.app_handle.clone();
            let runtime = app.state::<crate::runtime::AgentRuntimeManager>();
            let ws_state = app.state::<crate::commands::WorkspaceState>();
            let settings = app.state::<std::sync::Arc<crate::settings::SettingsService>>();
            // workspace_key（编码 key）→ 根路径：手机按工作区隔离发消息。
            // 新建会话必须落对目录；历史会话由 PWA 端按「会话归属工作区」映射带 key。
            let workspace_root = workspace_key
                .as_deref()
                .and_then(crate::commands::workspace::resolve_path_from_key);
            // provider 不传（None）：远程发消息不持有前端绑定，走会话元数据 → 全局
            // active 兜底（resolve_send_provider 语义）。
            crate::commands::chat::send_message(
                session_id, prompt, None, None, None, None,
                Some(permission_mode), None, workspace_root, None,
                runtime, ws_state, settings,
            ).await?;
            Ok(None)
        }
        BridgeAction::LoadMessages { session_id } => {
            let app = gateway.app_handle.clone();
            let ws_state = app.state::<crate::commands::WorkspaceState>();
            // 远程不分页：传 None 保持整读（向后兼容）；payload 从数组变对象
            // （LoadMessagesResult），remote-pwa 侧同步解析。
            let result = crate::commands::session::load_messages(ws_state, session_id, None, None).await?;
            Ok(Some(DesktopToPhone::Messages { messages: json!(result) }))
        }
        BridgeAction::ListSessions { workspace_key } => {
            let app = gateway.app_handle.clone();
            // 带 key 按指定工作区列；不带 = 桌面当前活动工作区（旧行为）
            let sessions = match workspace_key {
                Some(k) => crate::commands::session::list_sessions_for_workspace(k).await?,
                None => {
                    let ws_state = app.state::<crate::commands::WorkspaceState>();
                    crate::commands::session::list_sessions(ws_state).await?
                }
            };
            Ok(Some(DesktopToPhone::Sessions { sessions: json!(sessions) }))
        }
        BridgeAction::ListWorkspaces => {
            let workspaces = crate::commands::workspace::list_workspaces().await?;
            Ok(Some(DesktopToPhone::Workspaces { workspaces: json!(workspaces) }))
        }
    }
}
