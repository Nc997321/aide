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
    /// 发消息；无 session_id 时新建会话。
    /// workspace_key：目标工作区（编码 key，与 list_workspaces 返回一致）；
    /// None = 桌面当前活动工作区。历史会话必须带其归属工作区，
    /// 否则 cwd 会落到桌面当前工作区。
    SendMessage {
        session_id: Option<String>,
        prompt: String,
        workspace_key: Option<String>,
    },
    /// 拉历史
    LoadMessages { session_id: String },
    /// 会话列表；workspace_key 缺省 = 桌面当前活动工作区（向后兼容旧客户端）
    ListSessions { workspace_key: Option<String> },
    /// 工作区列表（name 已由桌面解码为路径字符串；missing = 目录已不在）
    ListWorkspaces,
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
    /// list_workspaces 的应答（WorkspaceInfo[] 原样透传）
    Workspaces { workspaces: Value },
}
