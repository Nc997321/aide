use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 手机 → 桌面（经中继桥接的应用协议）。
/// 中继是哑管道，不理解这些消息——只做字节级转发。
///
/// v2：通用 RPC。能力调用走 Invoke{command, params}（command 白名单见 rpc::REGISTRY），
/// 不再每加一个桌面能力就加一个消息变体。pair/auth 是连接生命周期，不属于 RPC。
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PhoneToDesktop {
    /// 首次配对：验证配对码
    Pair { code: String },
    /// 已配对：token 认证
    Auth { token: String },
    /// 通用命令调用：command 必须在 rpc::REGISTRY 白名单内，params 为该命令的参数 DTO
    /// （camelCase，与桌面前端 api 门面的调用形状一致）。
    Invoke {
        id: u64,
        command: String,
        params: Value,
    },
}

/// 桌面 → 手机
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopToPhone {
    PairOk {
        device_id: String,
        token: String,
    },
    AuthOk,
    AuthError {
        message: String,
    },
    /// 流式事件（ChatEvent 原样透传，与桌面 listen("chat-event") 的 payload 同形）
    Event {
        event: Value,
    },
    /// Invoke 成功/失败两个变体封闭结果空间——非法组合（同时带 payload 和 error）
    /// 在类型上造不出来。
    InvokeOk {
        id: u64,
        payload: Value,
    },
    InvokeErr {
        id: u64,
        error: String,
    },
}
