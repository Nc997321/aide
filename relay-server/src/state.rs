use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::protocol::{
    CODE_TTL_SECS, DESKTOP_PING_MAX_MISS, DESKTOP_PING_SECS, PHONE_SILENCE_SECS,
};

/// register 日志限频窗口（秒）：与 handler::DROP_LOG_WINDOW_SECS 同值。防注册
/// 风暴刷爆 stderr——2026-09-18 实测桌面双实例互踢 ~500 行/秒、六天 6.5GB。
const REGISTER_LOG_WINDOW_SECS: u64 = 60;

/// 单设备 register 日志限频器（语义镜像 handler::IdleDropLog，两点差异：
/// 跨任务存活于 RelayState——register 每次都是新连接新任务，per-task 状态
/// 拦不住风暴；无 flush_tail 对应物——限频器常驻，存量计数到点必结算，不丢）。
struct RegisterLog {
    last_emit: Option<Instant>,
    suppressed: u64,
    superseded: u64,
}

pub type Ws = WebSocketStream<TcpStream>;
pub type WsSink = SplitSink<Ws, Message>;
pub type WsStream = SplitStream<Ws>;

/// connect 向某设备的看守/桥接任务请求交回连接
pub type Claim = oneshot::Sender<(WsSink, WsStream)>;

/// 一条已注册桌面连接在路由表中的登记项：
/// gen 是代数号（同 device_id 重连/重挂后自增，旧任务凭它避免误删新登记）；
/// claim 用来请当前持有者（看守或桥接）把连接交还给新的 connect。
pub struct DeviceConn {
    pub gen: u64,
    pub claim: mpsc::Sender<Claim>,
}

/// TTL 与活体调参：生产默认值见 protocol 常量；测试注入短值走真实时钟，
/// 不依赖虚拟时钟与 IO 就绪的竞态（paused 下 advance 与帧处理顺序不可控）。
#[derive(Clone, Copy)]
pub struct LivenessCfg {
    pub code_ttl: Duration,
    pub phone_silence: Duration,
    pub desktop_ping: Duration,
    pub ping_max_miss: u32,
}

impl Default for LivenessCfg {
    fn default() -> Self {
        Self {
            code_ttl: Duration::from_secs(CODE_TTL_SECS),
            phone_silence: Duration::from_secs(PHONE_SILENCE_SECS),
            desktop_ping: Duration::from_secs(DESKTOP_PING_SECS),
            ping_max_miss: DESKTOP_PING_MAX_MISS,
        }
    }
}

/// 配对码路由条目：码 → 设备 + 宣告时刻（TTL 惰性过期的判据）。
/// 码路由是「桌面宣告的投影」：只经 register/update_code 进出，桥接结束不再删除
/// （旧实装在 teardown 删光路由，导致桌面仍展示的未过期码会话一结束即失效）。
struct CodeEntry {
    device_id: String,
    announced_at: Instant,
}

/// 路由表：device_id → 桌面连接（看守/桥接任务托管，经 claim 领回）；pairing_code → 设备。
/// 哑管道——不理解应用协议，只做路由 + 双向帧转发。
#[derive(Default)]
pub struct RelayState {
    pub devices: HashMap<String, DeviceConn>,
    codes: HashMap<String, CodeEntry>,
    register_logs: HashMap<String, RegisterLog>,
    next_gen: u64,
    pub liveness: LivenessCfg,
}

impl RelayState {
    /// 测试/定制构造：注入短 TTL/活体参数（生产走 Default）。
    pub fn with_liveness(liveness: LivenessCfg) -> Self {
        Self {
            liveness,
            ..Default::default()
        }
    }

    /// 登记一条新代连接，返回代数号
    pub fn insert_device(&mut self, device_id: String, claim: mpsc::Sender<Claim>) -> u64 {
        let gen = self.next_gen;
        self.next_gen += 1;
        self.devices.insert(device_id, DeviceConn { gen, claim });
        gen
    }

    /// 摘除指定代数的连接登记；代数不匹配（已重连换新）则不动
    pub fn remove_device_if(&mut self, device_id: &str, gen: u64) {
        if self.devices.get(device_id).is_some_and(|c| c.gen == gen) {
            self.devices.remove(device_id);
        }
    }

    /// 宣告配对码路由（register / update_code 共用入口）：先清该设备旧码再插新码。
    /// 同码 + 同设备重宣告保留原宣告时刻——TTL 对齐桌面码的生成时刻（auth.rs 600s），
    /// 不被 relay 重连续期；跨设备码碰撞 last-wins：碰撞只造成路由混淆不越权
    /// （配对终验在桌面 relay_client 的 validate），记档不特殊处理。
    pub fn announce_code(&mut self, device_id: &str, code: &str) {
        let kept_ts = self
            .codes
            .get(code)
            .filter(|e| e.device_id == device_id)
            .map(|e| e.announced_at);
        self.codes.retain(|_, e| e.device_id != device_id);
        let announced_at = kept_ts.unwrap_or_else(Instant::now);
        self.codes.insert(
            code.to_string(),
            CodeEntry {
                device_id: device_id.to_string(),
                announced_at,
            },
        );
    }

    /// 码 → 设备路由（TTL 惰性过期：查到即清，查不到留着也无害）。
    pub fn lookup_code(&mut self, code: &str) -> Option<String> {
        let entry = self.codes.get(code)?;
        if entry.announced_at.elapsed() > self.liveness.code_ttl {
            let code = code.to_string();
            self.codes.remove(&code);
            return None;
        }
        Some(entry.device_id.clone())
    }

    /// register 日志限频（按设备）：首条立即出（保留素指纹），窗口内静默计数，
    /// 到点带计数结算；superseded 单独计数——它是双实例互踢战争的直接证据
    /// （正常单实例下永不出现）。返回 Some(完整文案) = 该打；文案恒含
    /// `registered device {id}` grep 指纹。时钟经参数注入（now），纯逻辑可单测。
    pub fn note_register(
        &mut self,
        now: Instant,
        device_id: &str,
        superseded: bool,
    ) -> Option<String> {
        const WINDOW: Duration = Duration::from_secs(REGISTER_LOG_WINDOW_SECS);
        let log = self.register_logs.entry(device_id.to_string()).or_insert(RegisterLog {
            last_emit: None,
            suppressed: 0,
            superseded: 0,
        });
        log.suppressed += 1;
        if superseded {
            log.superseded += 1;
        }
        let due = match log.last_emit {
            None => true,
            Some(last) => now.duration_since(last) >= WINDOW,
        };
        if !due {
            return None;
        }
        let n = log.suppressed;
        let s = log.superseded;
        log.suppressed = 0;
        log.superseded = 0;
        log.last_emit = Some(now);
        let base = format!("registered device {device_id}");
        Some(match (n, s) {
            (1, 0) => base,
            (1, _) => format!("{base} (superseded previous connection)"),
            (_, 0) => format!("{base} (suppressed {n} in last {WINDOW:?})"),
            (_, _) => format!("{base} (suppressed {n} in last {WINDOW:?}, {s} superseded)"),
        })
    }
}

pub type SharedState = Arc<Mutex<RelayState>>;

/// 锁毒化恢复（与桌面侧 src-tauri/src/remote/mod.rs::lock_recover 同语义）：
/// 毒锁只说明「持锁期间有 task panic」，路由表/码表值守恒（整体赋值语义），
/// 取回守卫继续——比 unwrap 让每次 register/connect  panic 级联、毒死全 relay 强。
pub fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod register_log_tests {
    use super::*;

    /// 分支对账表（note_register 全臂）：
    /// | 分支 | 覆盖测试 |
    /// |---|---|
    /// | 首发（last_emit=None）→ 立即出、素指纹 | first_register_emits_plain |
    /// | 窗口内 → None（计数累计） | registers_within_window_are_suppressed |
    /// | 边界 == window（>= 语义）→ 结算 | window_elapsed_emits_with_count |
    /// | 窗口到点、多笔、无顶替 → 带计数 | window_elapsed_emits_with_count |
    /// | 窗口到点、多笔、含顶替 → 计数 + superseded | window_count_includes_superseded |
    /// | 单笔顶替（首发/窗口后第一笔）→ 顶替标注 | single_supersede_is_flagged |
    /// | 结算后清零 → 下一窗口重新计数 | settle_resets_counters |

    #[test]
    fn first_register_emits_plain() {
        let mut st = RelayState::default();
        assert_eq!(
            st.note_register(Instant::now(), "dev1", false).as_deref(),
            Some("registered device dev1")
        );
    }

    #[test]
    fn registers_within_window_are_suppressed() {
        let mut st = RelayState::default();
        let t0 = Instant::now();
        st.note_register(t0, "dev1", false);
        assert_eq!(st.note_register(t0 + Duration::from_secs(1), "dev1", true), None);
        assert_eq!(st.note_register(t0 + Duration::from_secs(59), "dev1", true), None);
    }

    #[test]
    fn window_elapsed_emits_with_count() {
        let mut st = RelayState::default();
        let t0 = Instant::now();
        st.note_register(t0, "dev1", false);
        for i in 1..=5 {
            st.note_register(t0 + Duration::from_secs(i), "dev1", false);
        }
        // 第 7 笔到点：n=6 = 窗口内 5 笔静默 + 本笔（镜像 IdleDropLog 语义），无顶替
        assert_eq!(
            st.note_register(t0 + Duration::from_secs(60), "dev1", false).as_deref(),
            Some("registered device dev1 (suppressed 6 in last 60s)")
        );
    }

    #[test]
    fn window_count_includes_superseded() {
        let mut st = RelayState::default();
        let t0 = Instant::now();
        st.note_register(t0, "dev1", false);
        for i in 1..=4 {
            st.note_register(t0 + Duration::from_secs(i), "dev1", true);
        }
        // n=5 = 窗口内 4 笔静默 + 本笔，全部是顶替
        assert_eq!(
            st.note_register(t0 + Duration::from_secs(60), "dev1", true).as_deref(),
            Some("registered device dev1 (suppressed 5 in last 60s, 5 superseded)")
        );
    }

    #[test]
    fn single_supersede_is_flagged() {
        let mut st = RelayState::default();
        let t0 = Instant::now();
        st.note_register(t0, "dev1", false);
        // 窗口后第一笔即是顶替：单笔标注
        assert_eq!(
            st.note_register(t0 + Duration::from_secs(60), "dev1", true).as_deref(),
            Some("registered device dev1 (superseded previous connection)")
        );
    }

    #[test]
    fn settle_resets_counters() {
        let mut st = RelayState::default();
        let t0 = Instant::now();
        st.note_register(t0, "dev1", true);
        // 结算后：下一窗口的首笔是素指纹（顶替计数已清零）
        assert_eq!(
            st.note_register(t0 + Duration::from_secs(60), "dev1", false).as_deref(),
            Some("registered device dev1")
        );
    }
}
