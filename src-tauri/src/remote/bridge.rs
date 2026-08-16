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
    SendMessage { session_id: String, prompt: String },
    LoadMessages { session_id: String },
    ListSessions,
}

/// 纯映射：认证检查 + 消息规范化（无 session_id 时生成 remote- 前缀 id）。
/// permission_mode 不在这里——执行时读设置（可中途改，每次执行生效）。
pub fn map_message(msg: &PhoneToDesktop, authed: bool) -> Result<BridgeAction, String> {
    match msg {
        PhoneToDesktop::Pair { code } => Ok(BridgeAction::Pair { code: code.clone() }),
        PhoneToDesktop::Auth { token } => Ok(BridgeAction::Auth { token: token.clone() }),
        PhoneToDesktop::SendMessage { session_id, prompt } => {
            if !authed { return Err("未认证：请先配对".into()); }
            let sid = session_id.clone()
                .unwrap_or_else(|| format!("remote-{}", auth::generate_device_id()));
            Ok(BridgeAction::SendMessage { session_id: sid, prompt: prompt.clone() })
        }
        PhoneToDesktop::LoadMessages { session_id } => {
            if !authed { return Err("未认证：请先配对".into()); }
            Ok(BridgeAction::LoadMessages { session_id: session_id.clone() })
        }
        PhoneToDesktop::ListSessions => {
            if !authed { return Err("未认证：请先配对".into()); }
            Ok(BridgeAction::ListSessions)
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
        BridgeAction::SendMessage { session_id, prompt } => {
            // 远程权限模式每次执行时读设置（可中途改，立即生效）
            let permission_mode = read_remote_settings(&gateway.app_handle).await?.permission_mode;
            let app = gateway.app_handle.clone();
            let runtime = app.state::<crate::runtime::AgentRuntimeManager>();
            let ws_state = app.state::<crate::commands::WorkspaceState>();
            let settings = app.state::<std::sync::Arc<crate::settings::SettingsService>>();
            crate::commands::chat::send_message(
                session_id, prompt, None, None, None, None,
                Some(permission_mode), None, None,
                runtime, ws_state, settings,
            ).await?;
            Ok(None)
        }
        BridgeAction::LoadMessages { session_id } => {
            let app = gateway.app_handle.clone();
            let ws_state = app.state::<crate::commands::WorkspaceState>();
            let messages = crate::commands::session::load_messages(ws_state, session_id).await?;
            Ok(Some(DesktopToPhone::Messages { messages: json!(messages) }))
        }
        BridgeAction::ListSessions => {
            let app = gateway.app_handle.clone();
            let ws_state = app.state::<crate::commands::WorkspaceState>();
            let sessions = crate::commands::session::list_sessions(ws_state).await?;
            Ok(Some(DesktopToPhone::Sessions { sessions: json!(sessions) }))
        }
    }
}
