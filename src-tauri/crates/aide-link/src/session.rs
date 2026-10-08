//! 一条**已认证**连接上的 Link 协议状态机（传输 / 加密无关）：`hello` → 调用 / 订阅 / 心跳。
//!
//! 认证发生在更低一层（[`crate::connection::Connection`] 里的 Noise 握手）：能走到这里的客户端
//! 要么持有已配对的手机密钥，要么刚用二维码里的一次性密钥完成了配对——所以本状态机不再有
//! 凭据帧。
//!
//! 驱动方（[`crate::connection::Connection`]）做三件事：
//! 1. 收到一个解密后的 Link 帧文本 → [`Session::on_text`]；
//! 2. 隔一小段时间 → [`Session::on_tick`]（心跳、超时、配对状态变化）；
//! 3. 把 [`Session::new`] 时给的 `out` 通道里的 [`HostFrame`] 加密发出，[`Session::is_closed`]
//!    为真（已发出 `bye`）后收尾。
//!
//! 并发：`call` 在独立任务里跑（慢命令不堵后续帧），应答经同一条 `out` 通道，所以无序到达是正常的
//! （客户端按 `id` 对号）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;

use crate::backend::{Backend, Subscription};
use crate::catalog::{Catalog, LINK_DESCRIBE, LINK_UNPAIR};
use crate::frame::{ClientFrame, ErrorCode, HostFrame, Limits, MAX_FRAME_BYTES, MAX_IN_FLIGHT};
use crate::identity::{Change, Identity};

/// Host 在连接空闲这么久后主动发 `ping`。
pub const PING_AFTER: Duration = Duration::from_secs(25);
/// 超过这么久没收到客户端任何帧 → `bye{timeout}`。
pub const DEAD_AFTER: Duration = Duration::from_secs(75);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    /// 还没收到 `hello`。
    New,
    Ready,
}

pub struct Session {
    backend: Arc<dyn Backend>,
    identity: Arc<Identity>,
    version: u32,
    out: UnboundedSender<HostFrame>,
    stage: Stage,
    closed: bool,
    sub: Option<Box<dyn Subscription>>,
    in_flight: Arc<AtomicUsize>,
    last_rx: Instant,
    last_ping: Instant,
    ping_n: u64,
    /// 建立连接时的配对状态代数 + 变化通道：之后被顶替 / 撤销就踢本连接。
    established_gen: u64,
    changes: watch::Receiver<(u64, Change)>,
}

impl Session {
    /// `version` = 安全通道握手里协商好的协议版本。
    pub fn new(backend: Arc<dyn Backend>, identity: Arc<Identity>, version: u32, out: UnboundedSender<HostFrame>) -> Self {
        let now = Instant::now();
        let changes = identity.watch();
        let established_gen = identity.generation();
        Self {
            backend,
            identity,
            version,
            out,
            stage: Stage::New,
            closed: false,
            sub: None,
            in_flight: Arc::new(AtomicUsize::new(0)),
            last_rx: now,
            last_ping: now,
            ping_n: 0,
            established_gen,
            changes,
        }
    }

    /// 已发出终止帧：驱动方发完 `out` 里剩下的帧就该关连接了。
    pub fn is_closed(&self) -> bool {
        self.closed
    }

    fn send(&self, f: HostFrame) {
        let _ = self.out.send(f);
    }

    fn close(&mut self, code: ErrorCode, message: &str) {
        if !self.closed {
            self.send(HostFrame::bye(code, message));
            self.closed = true;
            self.sub = None;
        }
    }

    /// 收到一个（已解密的）Link 帧。
    pub async fn on_text(&mut self, text: &str) {
        if self.closed {
            return;
        }
        self.last_rx = Instant::now();
        if text.len() > MAX_FRAME_BYTES {
            return self.close(ErrorCode::TooLarge, "frame exceeds the size limit");
        }
        self.check_pairing();
        if self.closed {
            return;
        }
        let frame: ClientFrame = match serde_json::from_str(text) {
            Ok(f) => f,
            Err(e) => {
                // hello 之前的乱码 = 不是我们的客户端，直接断；之后只回错误、连接继续
                if self.stage == Stage::New {
                    return self.close(ErrorCode::ProtocolError, "first frame must be `hello`");
                }
                return self.send(HostFrame::error(None, ErrorCode::InvalidFrame, format!("unparseable frame: {e}")));
            }
        };
        match (self.stage, frame) {
            (Stage::New, ClientFrame::Hello { .. }) => {
                self.stage = Stage::Ready;
                self.send(HostFrame::HelloOk {
                    version: self.version,
                    host: self.backend.host(),
                    granted: Catalog::granted(),
                    limits: Limits { max_frame_bytes: MAX_FRAME_BYTES, max_in_flight: MAX_IN_FLIGHT },
                });
            }
            (Stage::New, _) => self.close(ErrorCode::ProtocolError, "first frame must be `hello`"),
            (Stage::Ready, ClientFrame::Hello { .. }) => {
                self.send(HostFrame::error(None, ErrorCode::InvalidFrame, "already greeted"))
            }
            (_, ClientFrame::Ping { n }) => self.send(HostFrame::Pong { n }),
            (_, ClientFrame::Pong { .. }) => {}
            (Stage::Ready, ClientFrame::Call { id, method, params }) => self.on_call(id, method, params),
            (Stage::Ready, ClientFrame::Subscribe { sessions, since }) => {
                // 再订 = 替换：先放掉旧的（要无缝请带 `since`）
                self.sub = None;
                self.sub = Some(self.backend.attach_events(self.out.clone(), sessions, since));
            }
            (Stage::Ready, ClientFrame::Unsubscribe) => self.sub = None,
        }
    }

    /// 周期性维护：心跳 / 超时 / 配对状态变化。驱动方约每秒调一次。
    pub fn on_tick(&mut self, now: Instant) {
        if self.closed {
            return;
        }
        self.check_pairing();
        if self.closed {
            return;
        }
        if now.duration_since(self.last_rx) >= DEAD_AFTER {
            return self.close(ErrorCode::Timeout, "no frames from the client");
        }
        if now.duration_since(self.last_rx) >= PING_AFTER && now.duration_since(self.last_ping) >= PING_AFTER {
            self.ping_n += 1;
            self.last_ping = now;
            self.send(HostFrame::Ping { n: self.ping_n });
        }
    }

    /// 配对状态换代了（被新设备顶替 / 被撤销）就踢掉自己。
    fn check_pairing(&mut self) {
        if self.identity.generation() == self.established_gen {
            return;
        }
        let (_, change) = *self.changes.borrow();
        match change {
            Change::Superseded => self.close(ErrorCode::Superseded, "another device paired with this Host"),
            _ => self.close(ErrorCode::Revoked, "pairing was revoked"),
        }
    }

    fn on_call(&mut self, id: u64, method: String, params: Value) {
        // 协议自己的方法：不转给 Host
        if method == LINK_DESCRIBE {
            return self.send(HostFrame::Result { id, value: Catalog::describe() });
        }
        if method == LINK_UNPAIR {
            self.send(HostFrame::Result { id, value: Value::Null });
            if let Err(e) = self.identity.revoke() {
                tracing::warn!("link.unpair: revoke failed: {e}");
            }
            // 配对换代 → 紧跟在应答之后踢掉本连接（bye{revoked}）
            self.check_pairing();
            return;
        }
        if Catalog::group_of(&method).is_none() {
            return self.send(HostFrame::error(Some(id), ErrorCode::UnknownMethod, format!("unknown method `{method}`")));
        }
        if self.in_flight.load(Ordering::SeqCst) >= MAX_IN_FLIGHT {
            return self.send(HostFrame::error(Some(id), ErrorCode::Busy, "too many calls in flight"));
        }
        let params = match Catalog::prepare(&method, params, &self.backend.policy()) {
            Ok(p) => p,
            Err(e) => return self.send(HostFrame::error(Some(id), ErrorCode::InvalidParams, e)),
        };
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let fut = self.backend.call(&method, params);
        let out = self.out.clone();
        let in_flight = Arc::clone(&self.in_flight);
        tokio::spawn(async move {
            let frame = match fut.await {
                Ok(value) => HostFrame::Result { id, value },
                Err(message) => HostFrame::error(Some(id), ErrorCode::Failed, message),
            };
            in_flight.fetch_sub(1, Ordering::SeqCst);
            let _ = out.send(frame);
        });
    }
}
