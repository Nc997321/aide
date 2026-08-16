use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 手机 → 桌面（经中继桥接的应用协议）。
/// 中继是哑管道，不理解这些消息——只做字节级转发。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PhoneToDesktop {
    /// 首次配对：验证配对码
    Pair { code: String },
    /// 已配对：token 认证
    Auth { token: String },
    /// 发消息；无 session_id 时新建会话
    SendMessage { session_id: Option<String>, prompt: String },
    /// 拉历史
    LoadMessages { session_id: String },
    /// 会话列表
    ListSessions,
}

/// 桌面 → 手机
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopToPhone {
    PairOk { device_id: String, token: String },
    AuthOk,
    AuthError { message: String },
    /// 流式事件（ChatEvent 原样透传）
    Event { event: Value },
    /// 命令回执/错误
    Error { message: String },
    /// list_sessions / load_messages 的应答（现有命令结果原样透传）
    Sessions { sessions: Value },
    Messages { messages: Value },
}
