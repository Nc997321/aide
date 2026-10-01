//! 中继层帧契约：relay 唯一理解的几种帧（register/connect 首消息 + 中途控制帧）。
//! 哑管道边界：本文件之外的帧一律原样转发，不解析。
//! Aide Link 的 Host（aide-link/transport/relay）以 `register{device_id}` 无码注册，只按 device_id 路由；
//! 镜像义务：手机发送侧（keepalive）/ 接收侧（connect_error）见 docs/aide-link-protocol.md §2.2。
//! 旧协议 v2 的配对码路由（`register.pairing_code` / `update_code` / `connect{code}`）已随桌面网关退役删除。

use serde_json::Value;

/// 手机腿静默超时（秒）：仅在该腿观测到首帧 keepalive 后武装（opt-in，老客户端保持旧行为）。
pub const PHONE_SILENCE_SECS: u64 = 60;
/// 桌面腿活体 Ping 间隔（秒）。
pub const DESKTOP_PING_SECS: u64 = 30;
/// 连续 Ping 未回 Pong 达此次数判桌面腿死。
pub const DESKTOP_PING_MAX_MISS: u32 = 3;

/// 关连接前的原因帧（relay → 手机）：让手机区分码错 / 设备离线 / 被新连接顶替，
/// 不再把三种成因混成同一个「offline 重试」。
#[derive(Clone, Copy)]
pub enum ConnectErrorReason {
    /// 旧协议的 `connect{code}`：码路由已不存在，恒回这个原因（让旧手机端得到类型化的拒绝而不是裸断）。
    UnknownCode,
    DeviceOffline,
    Superseded,
}

impl ConnectErrorReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::UnknownCode => "unknown_code",
            Self::DeviceOffline => "device_offline",
            Self::Superseded => "superseded",
        }
    }
}

/// connect_error 帧文本（发送范式 send→flush→2s close 见 handler）。
/// 手写而非 json!：serde_json 默认 BTreeMap 会重排键序，wire 格式必须逐字节确定
/// （三端按字符串契约对账）。reason 取值封闭在 ConnectErrorReason，无转义需求。
pub fn connect_error_frame(reason: ConnectErrorReason) -> String {
    format!(
        r#"{{"type":"connect_error","reason":"{}"}}"#,
        reason.as_str()
    )
}

/// 手机腿帧是否 keepalive（消费不转发；首帧武装静默超时）。
/// 手机腿低速率（用户动作 + 20s 一跳），全解析可接受；解析失败 = false → 原样转发。
pub fn is_keepalive(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            v.get("type")
                .and_then(Value::as_str)
                .map(|t| t == "keepalive")
        })
        .unwrap_or(false)
}
