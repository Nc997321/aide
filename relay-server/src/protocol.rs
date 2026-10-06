//! 中继层帧契约：relay 唯一理解的几种帧（首消息 + 中途控制帧）。
//! 哑管道边界：本文件之外的帧一律原样转发，不解析。
//!
//! **连接模型（proto 2）：控制腿 + 一次性桥接腿。**
//! - Host 出站 `register{device_id, proto:2}` = **控制腿**，只传 `incoming` 通知，永远不承载业务字节；
//! - 手机 `connect{device_id}` 时，中继为这次连接生成 `bridge_id`，经控制腿发 `incoming{bridge_id}`；
//! - Host 为之**新开一条出站连接**，首帧 `attach{bridge_id}` = **桥接腿**，与手机腿桥接；
//! - 桥接结束（任一方走了 / 被顶替 / 死亡）**中继关掉桥接腿，永不复用**。
//!
//! 一次桥接 = 一条专属腿 = Host 侧一个 `Connection`：Host 的会话生命周期与桥接生命周期是同一件事，
//! 不再靠「下一个 `sc_init` 到了才发现手机换了」来推断（旧模型：腿被顺序复用，手机走后旧会话还挂着总线订阅，
//! 往已经接给下一部手机的腿里泵旧密钥的密文——手机侧表现为握手前密文 / 解密失败 / 瞬断）。
//!
//! 镜像义务：手机发送侧（keepalive）/ 接收侧（connect_error）见 docs/aide-link-protocol.md §2.2。
//! 旧协议 v2 的配对码路由（`register.pairing_code` / `update_code` / `connect{code}`）已随桌面网关退役删除。

use rand::RngCore;
use serde_json::Value;

/// 中继 ↔ Host 的连接模型版本（`register.proto`）。缺省 / 不等 = 旧版 Host（腿被顺序复用的模型），
/// 中继拒绝并回 `register_error{unsupported_proto}`——两种模型不能共存，混用就是僵尸会话的温床。
pub const HOST_PROTO: u64 = 2;
/// 中继发出 `incoming` 后等 Host 拨回 `attach` 的上限（秒）：超时 = 手机得 `device_offline`。
pub const ATTACH_TIMEOUT_SECS: u64 = 8;

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

/// `incoming` 帧文本（中继 → Host 控制腿）：有手机来了，请拨回并 `attach{bridge_id}`。
pub fn incoming_frame(bridge_id: &str) -> String {
    format!(r#"{{"type":"incoming","bridge_id":"{bridge_id}"}}"#)
}

/// `register_error` 帧文本（中继 → Host，之后关连接）。
pub fn register_error_frame(reason: &str) -> String {
    format!(r#"{{"type":"register_error","reason":"{reason}"}}"#)
}

/// 一次桥接的不可猜标识（128 位随机，32 位十六进制）：持有它才能认领这条手机腿，
/// 只经 TLS 下的控制腿发给已注册的 Host。
pub fn new_bridge_id() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
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
