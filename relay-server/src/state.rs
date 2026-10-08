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
    ATTACH_TIMEOUT_SECS, DESKTOP_PING_MAX_MISS, DESKTOP_PING_SECS, PHONE_SILENCE_SECS,
};

/// register 日志限频窗口（秒）。防注册
/// 风暴刷爆 stderr——2026-09-18 实测桌面双实例互踢 ~500 行/秒、六天 6.5GB。
const REGISTER_LOG_WINDOW_SECS: u64 = 60;

/// 单设备 register 日志限频器：跨任务存活于 RelayState——register 每次都是新连接新任务，
/// per-task 状态拦不住风暴；限频器常驻，存量计数到点必结算，不丢。
struct RegisterLog {
    last_emit: Option<Instant>,
    suppressed: u64,
    superseded: u64,
}

pub type Ws = WebSocketStream<TcpStream>;
pub type WsSink = SplitSink<Ws, Message>;
pub type WsStream = SplitStream<Ws>;

/// 一条 Host 出站连接的两半（WebSocket 读写）。
pub type HostLeg = (WsSink, WsStream);

/// 已注册 Host 的**控制腿**在路由表中的登记项。控制腿只传 `incoming` 通知：
/// gen 是代数号（同 device_id 重新注册后自增，旧任务凭它避免误删新登记）；
/// incoming 是给控制腿任务递 `bridge_id` 的通道（发送端被覆盖/丢弃 = 控制腿被顶替，任务据此收尾）。
pub struct HostConn {
    pub gen: u64,
    pub incoming: mpsc::Sender<String>,
}

/// 某设备当前的手机桥接（至多一条）：新的 connect 经 `kick` 顶替它。
struct ActiveBridge {
    gen: u64,
    kick: mpsc::Sender<()>,
}

/// TTL 与活体调参：生产默认值见 protocol 常量；测试注入短值走真实时钟，
/// 不依赖虚拟时钟与 IO 就绪的竞态（paused 下 advance 与帧处理顺序不可控）。
#[derive(Clone, Copy)]
pub struct LivenessCfg {
    pub phone_silence: Duration,
    pub desktop_ping: Duration,
    pub ping_max_miss: u32,
    /// 发出 `incoming` 后等 Host `attach` 的上限。
    pub attach_timeout: Duration,
}

impl Default for LivenessCfg {
    fn default() -> Self {
        Self {
            phone_silence: Duration::from_secs(PHONE_SILENCE_SECS),
            desktop_ping: Duration::from_secs(DESKTOP_PING_SECS),
            ping_max_miss: DESKTOP_PING_MAX_MISS,
            attach_timeout: Duration::from_secs(ATTACH_TIMEOUT_SECS),
        }
    }
}

/// 路由表：device_id → Host 控制腿；bridge_id → 等待 Host 拨回的手机连接；device_id → 当前桥接。
/// **只按 device_id 路由**——不存在任何配对码 / 配对秘密（配对在端到端加密的通道里完成，中继看不到）。
/// 哑管道——不理解应用协议，只做路由 + 双向帧转发。
#[derive(Default)]
pub struct RelayState {
    hosts: HashMap<String, HostConn>,
    pending: HashMap<String, oneshot::Sender<HostLeg>>,
    bridges: HashMap<String, ActiveBridge>,
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

    fn bump(&mut self) -> u64 {
        let gen = self.next_gen;
        self.next_gen += 1;
        gen
    }

    /// 登记一条新代控制腿（覆盖旧的），返回代数号。
    pub fn insert_host(&mut self, device_id: String, incoming: mpsc::Sender<String>) -> u64 {
        let gen = self.bump();
        self.hosts.insert(device_id, HostConn { gen, incoming });
        gen
    }

    /// 摘除指定代数的控制腿登记；代数不匹配（已重新注册）则不动。
    pub fn remove_host_if(&mut self, device_id: &str, gen: u64) {
        if self.hosts.get(device_id).is_some_and(|c| c.gen == gen) {
            self.hosts.remove(device_id);
        }
    }

    pub fn host_registered(&self, device_id: &str) -> bool {
        self.hosts.contains_key(device_id)
    }

    pub fn host_incoming(&self, device_id: &str) -> Option<mpsc::Sender<String>> {
        self.hosts.get(device_id).map(|h| h.incoming.clone())
    }

    /// 开始一次桥接：顶替该设备此前的桥接（单设备模型：同一 Host 同时只服务一部手机），
    /// 返回代数号与「被顶替」通知的接收端。
    pub fn begin_bridge(&mut self, device_id: &str) -> (u64, mpsc::Receiver<()>) {
        let gen = self.bump();
        let (kick, kick_rx) = mpsc::channel(1);
        if let Some(old) = self.bridges.insert(device_id.to_string(), ActiveBridge { gen, kick }) {
            let _ = old.kick.try_send(());
        }
        (gen, kick_rx)
    }

    /// 桥接收尾：仅当登记仍是本代才摘（被顶替后新代已占位，不能误删）。
    pub fn end_bridge_if(&mut self, device_id: &str, gen: u64) {
        if self.bridges.get(device_id).is_some_and(|b| b.gen == gen) {
            self.bridges.remove(device_id);
        }
    }

    /// 登记一个等 Host 拨回的桥接请求。
    pub fn add_pending(&mut self, bridge_id: String) -> oneshot::Receiver<HostLeg> {
        let (tx, rx) = oneshot::channel();
        self.pending.insert(bridge_id, tx);
        rx
    }

    /// Host 拨回：认领（一次性）。
    pub fn take_pending(&mut self, bridge_id: &str) -> Option<oneshot::Sender<HostLeg>> {
        self.pending.remove(bridge_id)
    }

    pub fn drop_pending(&mut self, bridge_id: &str) {
        self.pending.remove(bridge_id);
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

/// 锁毒化恢复：
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
