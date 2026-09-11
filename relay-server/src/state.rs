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
}

pub type SharedState = Arc<Mutex<RelayState>>;

/// 锁毒化恢复（与桌面侧 src-tauri/src/remote/mod.rs::lock_recover 同语义）：
/// 毒锁只说明「持锁期间有 task panic」，路由表/码表值守恒（整体赋值语义），
/// 取回守卫继续——比 unwrap 让每次 register/connect  panic 级联、毒死全 relay 强。
pub fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
