//! 线上的帧：**协议的唯一真相源**（`docs/aide-link-protocol.md` 是它的叙述版，二者冲突以本文件
//! + `tests/fixtures/` 为准）。
//!
//! 约定：
//! - 一帧 = 一个 JSON 对象 = 一条 WebSocket 文本消息，`type` 区分种类（snake_case）；
//! - 帧自身的字段 snake_case；`params` / `payload` / `value` 里是 Host 命令的原样 JSON（camelCase）；
//! - 接收方**忽略未知字段**（向前兼容）；客户端忽略未知的 Host 帧类型，Host 对未知的客户端
//!   帧类型回 `error{invalid_frame}`。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 本实现支持的协议版本（hello 里协商）。不兼容变更才加新版本号，兼容的扩展（新字段 / 新帧
/// 类型 / 新方法）留在原版本内。
pub const SUPPORTED_VERSIONS: &[u32] = &[1];

/// 单帧上限（字节）。超过 = 协议违规，Host 以 `bye{too_large}` 断开。
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// 同一连接上同时在途的 `call` 上限，超过回 `error{busy}`。
pub const MAX_IN_FLIGHT: usize = 64;

/// 客户端 → Host。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    /// 连接后的第一帧：声明自己会的协议版本。
    Hello {
        versions: Vec<u32>,
        #[serde(default)]
        client: ClientInfo,
    },
    /// 首次配对：凭 Host 上显示的配对码换长期 token。
    Pair {
        code: String,
        #[serde(default)]
        device: DeviceInfo,
    },
    /// 已配对：凭 token 认证。
    Auth { token: String },
    /// 调用一个 Host 方法（目录见 `link.describe`）。`id` 由客户端选，连接内在途唯一。
    Call {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    },
    /// 订阅事件流（认证后才能订；再订一次 = 替换订阅）。
    Subscribe {
        /// `null` = 全部会话；`[…]` = 只收这些会话的 `chat-event`（不带会话号的事件照常收）。
        #[serde(default)]
        sessions: Option<Vec<String>>,
        /// 断线续传：上次连接最后收到的位置。
        #[serde(default)]
        since: Option<Since>,
    },
    Unsubscribe,
    Ping { n: u64 },
    Pong { n: u64 },
}

/// Host → 客户端。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostFrame {
    HelloOk {
        /// 选定的协议版本（客户端 `versions` 与 Host 支持的交集里最大的）。
        version: u32,
        host: HostInfo,
        /// 可用的认证方式：`pair`（配对码）/ `token`。
        auth: Vec<String>,
        limits: Limits,
    },
    /// 协商失败；随后 Host 关闭连接。
    HelloErr { code: ErrorCode, supported: Vec<u32> },
    /// 配对成功：`device_id` 是这台 Host 在中继上的身份（客户端之后 `connect` 用），`token` 长期有效。
    Paired {
        device_id: String,
        token: String,
        granted: Vec<String>,
    },
    Authed { granted: Vec<String> },
    AuthError { code: ErrorCode, message: String },
    /// `call` 的成功应答。
    Result { id: u64, value: Value },
    /// `call` 的失败应答（`id` 缺省 = 不对应任何 call 的协议级错误）。
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        code: ErrorCode,
        message: String,
    },
    /// 订阅已生效；其后依次是回放的事件、实时事件。
    Subscribed(Subscribed),
    /// 一个 Host 事件。`seq` 在同一 `epoch` 内单调递增。
    Event {
        seq: u64,
        name: String,
        payload: Value,
    },
    Ping { n: u64 },
    Pong { n: u64 },
    /// Host 主动结束连接前的原因帧。
    Bye { code: ErrorCode, message: String },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ClientInfo {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub platform: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HostInfo {
    /// Host 在中继上的稳定身份（= `Paired.device_id`）。
    pub id: String,
    pub name: String,
    pub os: String,
    pub arch: String,
    /// aide-host / 桌面应用的版本。
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    pub max_frame_bytes: usize,
    pub max_in_flight: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_frame_bytes: MAX_FRAME_BYTES, max_in_flight: MAX_IN_FLIGHT }
    }
}

/// 续传位置：哪一代 Host（`epoch`，Host 进程每次启动换一个）的第几号事件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Since {
    pub epoch: String,
    pub seq: u64,
}

/// 订阅结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Subscribed {
    /// 当前这代 Host 的标识；与客户端记的不同 = Host 重启过，会话已不是原来那些。
    pub epoch: String,
    /// Host 当前的最新事件序号。
    pub seq: u64,
    /// 带了 `since` 且 `epoch` 对得上。
    pub resumed: bool,
    /// 想续传但 Host 已覆盖不到（错过的事件有丢失）：客户端需重新拉取状态。
    pub gap: bool,
    /// 本次回放了多少条。
    pub replayed: u64,
}

/// 封闭的错误码集合（客户端按码分支，`message` 只给人看）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    // 握手 / 认证
    UnsupportedVersion,
    BadCode,
    ExpiredCode,
    BadToken,
    TooManyAttempts,
    // 调用
    Unauthenticated,
    UnknownMethod,
    InvalidFrame,
    InvalidParams,
    Failed,
    Busy,
    Internal,
    // 连接终止（Bye）
    Superseded,
    Revoked,
    Shutdown,
    Timeout,
    TooLarge,
    ProtocolError,
}

impl ClientFrame {
    /// 全部客户端帧的 `type` 值（文档 / TypeScript 声明与之对账）。
    pub const TYPES: &'static [&'static str] =
        &["hello", "pair", "auth", "call", "subscribe", "unsubscribe", "ping", "pong"];
}

impl HostFrame {
    /// 全部 Host 帧的 `type` 值。
    pub const TYPES: &'static [&'static str] = &[
        "hello_ok", "hello_err", "paired", "authed", "auth_error", "result", "error", "subscribed", "event", "ping",
        "pong", "bye",
    ];
}

impl ErrorCode {
    /// 全部错误码（线上字面值）。
    pub const ALL: &'static [ErrorCode] = &[
        ErrorCode::UnsupportedVersion,
        ErrorCode::BadCode,
        ErrorCode::ExpiredCode,
        ErrorCode::BadToken,
        ErrorCode::TooManyAttempts,
        ErrorCode::Unauthenticated,
        ErrorCode::UnknownMethod,
        ErrorCode::InvalidFrame,
        ErrorCode::InvalidParams,
        ErrorCode::Failed,
        ErrorCode::Busy,
        ErrorCode::Internal,
        ErrorCode::Superseded,
        ErrorCode::Revoked,
        ErrorCode::Shutdown,
        ErrorCode::Timeout,
        ErrorCode::TooLarge,
        ErrorCode::ProtocolError,
    ];

    pub fn as_str(self) -> String {
        serde_json::to_value(self).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }
}

impl HostFrame {
    pub fn error(id: Option<u64>, code: ErrorCode, message: impl Into<String>) -> Self {
        HostFrame::Error { id, code, message: message.into() }
    }

    pub fn bye(code: ErrorCode, message: impl Into<String>) -> Self {
        HostFrame::Bye { code, message: message.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn roundtrip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(v: T, wire: Value) {
        assert_eq!(serde_json::to_value(&v).unwrap(), wire);
        assert_eq!(serde_json::from_value::<T>(wire).unwrap(), v);
    }

    /// 线上形状钉死：手机端按这些字面值实现。
    #[test]
    fn client_frames_have_the_documented_shape() {
        roundtrip(
            ClientFrame::Hello { versions: vec![1], client: ClientInfo { name: "pwa".into(), version: "1".into(), platform: "web".into() } },
            json!({"type":"hello","versions":[1],"client":{"name":"pwa","version":"1","platform":"web"}}),
        );
        roundtrip(
            ClientFrame::Call { id: 7, method: "list_sessions".into(), params: json!({}) },
            json!({"type":"call","id":7,"method":"list_sessions","params":{}}),
        );
        roundtrip(
            ClientFrame::Subscribe { sessions: None, since: Some(Since { epoch: "e1".into(), seq: 42 }) },
            json!({"type":"subscribe","sessions":null,"since":{"epoch":"e1","seq":42}}),
        );
        roundtrip(ClientFrame::Auth { token: "t".into() }, json!({"type":"auth","token":"t"}));
        roundtrip(ClientFrame::Ping { n: 1 }, json!({"type":"ping","n":1}));
    }

    #[test]
    fn host_frames_have_the_documented_shape() {
        roundtrip(
            HostFrame::Result { id: 7, value: json!([1]) },
            json!({"type":"result","id":7,"value":[1]}),
        );
        roundtrip(
            HostFrame::error(Some(7), ErrorCode::UnknownMethod, "nope"),
            json!({"type":"error","id":7,"code":"unknown_method","message":"nope"}),
        );
        roundtrip(
            HostFrame::error(None, ErrorCode::InvalidFrame, "bad"),
            json!({"type":"error","code":"invalid_frame","message":"bad"}),
        );
        roundtrip(
            HostFrame::Event { seq: 3, name: "chat-event".into(), payload: json!({"type":"x"}) },
            json!({"type":"event","seq":3,"name":"chat-event","payload":{"type":"x"}}),
        );
        roundtrip(
            HostFrame::Subscribed(Subscribed { epoch: "e".into(), seq: 9, resumed: true, gap: false, replayed: 2 }),
            json!({"type":"subscribed","epoch":"e","seq":9,"resumed":true,"gap":false,"replayed":2}),
        );
        roundtrip(
            HostFrame::bye(ErrorCode::Superseded, "paired elsewhere"),
            json!({"type":"bye","code":"superseded","message":"paired elsewhere"}),
        );
    }

    /// `TYPES` 常量必须与枚举逐一对应（每种帧造一个样本，序列化后取 `type`）。
    #[test]
    fn type_tables_match_the_enums() {
        let client = [
            ClientFrame::Hello { versions: vec![], client: ClientInfo::default() },
            ClientFrame::Pair { code: String::new(), device: DeviceInfo::default() },
            ClientFrame::Auth { token: String::new() },
            ClientFrame::Call { id: 0, method: String::new(), params: Value::Null },
            ClientFrame::Subscribe { sessions: None, since: None },
            ClientFrame::Unsubscribe,
            ClientFrame::Ping { n: 0 },
            ClientFrame::Pong { n: 0 },
        ];
        let host = [
            HostFrame::HelloOk { version: 1, host: HostInfo::default(), auth: vec![], limits: Limits::default() },
            HostFrame::HelloErr { code: ErrorCode::Internal, supported: vec![] },
            HostFrame::Paired { device_id: String::new(), token: String::new(), granted: vec![] },
            HostFrame::Authed { granted: vec![] },
            HostFrame::AuthError { code: ErrorCode::Internal, message: String::new() },
            HostFrame::Result { id: 0, value: Value::Null },
            HostFrame::error(None, ErrorCode::Internal, ""),
            HostFrame::Subscribed(Subscribed { epoch: String::new(), seq: 0, resumed: false, gap: false, replayed: 0 }),
            HostFrame::Event { seq: 0, name: String::new(), payload: Value::Null },
            HostFrame::Ping { n: 0 },
            HostFrame::Pong { n: 0 },
            HostFrame::bye(ErrorCode::Internal, ""),
        ];
        let tag = |v: Value| v["type"].as_str().unwrap().to_string();
        let got: Vec<String> = client.iter().map(|f| tag(serde_json::to_value(f).unwrap())).collect();
        assert_eq!(got, ClientFrame::TYPES);
        let got: Vec<String> = host.iter().map(|f| tag(serde_json::to_value(f).unwrap())).collect();
        assert_eq!(got, HostFrame::TYPES);
    }

    /// 向前兼容：未知字段被忽略；缺省字段取默认。
    #[test]
    fn unknown_fields_are_ignored_and_optionals_default() {
        let f: ClientFrame = serde_json::from_value(json!({"type":"call","id":1,"method":"m","future":true})).unwrap();
        assert_eq!(f, ClientFrame::Call { id: 1, method: "m".into(), params: Value::Null });
        let f: ClientFrame = serde_json::from_value(json!({"type":"subscribe"})).unwrap();
        assert_eq!(f, ClientFrame::Subscribe { sessions: None, since: None });
    }
}
