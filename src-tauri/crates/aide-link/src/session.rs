//! 一条客户端连接的协议状态机：握手 → 认证 → 调用 / 订阅，传输无关。
//!
//! 驱动方（传输适配器，如中继客户端）只做三件事：
//! 1. 收到一条文本消息 → [`Session::on_text`]；
//! 2. 隔一小段时间 → [`Session::on_tick`]（心跳、超时、凭据变化）；
//! 3. 把 [`Session::new`] 时给的 `out` 通道里的 [`HostFrame`] 序列化成文本发出去，
//!    [`Session::is_closed`] 为真（已发出 `bye` / `hello_err`）后在发完剩余帧后关连接。
//!
//! 并发：`call` 在独立任务里跑（慢命令不堵后续帧），应答经同一条 `out` 通道，所以无序到达是正常的
//! （客户端按 `id` 对号）。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;

use crate::auth::{Change, Credentials};
use crate::backend::{Backend, Subscription};
use crate::catalog::{Catalog, LINK_DESCRIBE, LINK_UNPAIR};
use crate::frame::{
    ClientFrame, ErrorCode, HostFrame, Limits, MAX_FRAME_BYTES, MAX_IN_FLIGHT, SUPPORTED_VERSIONS,
};

/// Host 在连接空闲这么久后主动发 `ping`。
pub const PING_AFTER: Duration = Duration::from_secs(25);
/// 超过这么久没收到客户端任何帧 → `bye{timeout}`。
pub const DEAD_AFTER: Duration = Duration::from_secs(75);
/// 单连接允许的认证失败次数。
pub const MAX_AUTH_FAILURES: u32 = 5;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    /// 还没收到 `hello`。
    New,
    /// 已协商版本，未认证。
    Greeted,
    Authed,
}

pub struct Session {
    backend: Arc<dyn Backend>,
    creds: Arc<Credentials>,
    out: UnboundedSender<HostFrame>,
    stage: Stage,
    closed: bool,
    sub: Option<Box<dyn Subscription>>,
    in_flight: Arc<AtomicUsize>,
    auth_failures: u32,
    last_rx: Instant,
    last_ping: Instant,
    ping_n: u64,
    /// 认证成功时的凭据代数 + 变化通道：之后 token 被顶替 / 撤销就踢本连接。
    authed_gen: u64,
    changes: watch::Receiver<(u64, Change)>,
}

impl Session {
    pub fn new(backend: Arc<dyn Backend>, creds: Arc<Credentials>, out: UnboundedSender<HostFrame>) -> Self {
        let now = Instant::now();
        let changes = creds.watch();
        Self {
            backend,
            creds,
            out,
            stage: Stage::New,
            closed: false,
            sub: None,
            in_flight: Arc::new(AtomicUsize::new(0)),
            auth_failures: 0,
            last_rx: now,
            last_ping: now,
            ping_n: 0,
            authed_gen: 0,
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

    /// 收到一条文本消息（一帧）。
    pub async fn on_text(&mut self, text: &str) {
        if self.closed {
            return;
        }
        self.last_rx = Instant::now();
        if text.len() > MAX_FRAME_BYTES {
            return self.close(ErrorCode::TooLarge, "frame exceeds the size limit");
        }
        self.check_credentials();
        if self.closed {
            return;
        }
        let frame: ClientFrame = match serde_json::from_str(text) {
            Ok(f) => f,
            Err(e) => {
                // 握手前的乱码 = 不是我们的客户端，直接断；握手后只回错误、连接继续
                if self.stage == Stage::New {
                    return self.close(ErrorCode::ProtocolError, "first frame must be `hello`");
                }
                return self.send(HostFrame::error(None, ErrorCode::InvalidFrame, format!("unparseable frame: {e}")));
            }
        };
        match (self.stage, frame) {
            (Stage::New, ClientFrame::Hello { versions, .. }) => self.on_hello(&versions),
            (Stage::New, _) => self.close(ErrorCode::ProtocolError, "first frame must be `hello`"),
            (_, ClientFrame::Hello { .. }) => {
                self.send(HostFrame::error(None, ErrorCode::InvalidFrame, "already greeted"))
            }
            (_, ClientFrame::Ping { n }) => self.send(HostFrame::Pong { n }),
            (_, ClientFrame::Pong { .. }) => {}
            (Stage::Greeted, ClientFrame::Pair { code, .. }) => self.on_pair(&code),
            (Stage::Greeted, ClientFrame::Auth { token }) => self.on_auth(&token),
            (Stage::Greeted, ClientFrame::Call { id, .. }) => {
                self.send(HostFrame::error(Some(id), ErrorCode::Unauthenticated, "pair or auth first"))
            }
            (Stage::Greeted, ClientFrame::Subscribe { .. } | ClientFrame::Unsubscribe) => {
                self.send(HostFrame::error(None, ErrorCode::Unauthenticated, "pair or auth first"))
            }
            (Stage::Authed, ClientFrame::Pair { .. } | ClientFrame::Auth { .. }) => {
                self.send(HostFrame::error(None, ErrorCode::InvalidFrame, "already authenticated"))
            }
            (Stage::Authed, ClientFrame::Call { id, method, params }) => self.on_call(id, method, params),
            (Stage::Authed, ClientFrame::Subscribe { sessions, since }) => {
                // 再订 = 替换：先放掉旧的（要无缝请带 `since`）
                self.sub = None;
                self.sub = Some(self.backend.attach_events(self.out.clone(), sessions, since));
            }
            (Stage::Authed, ClientFrame::Unsubscribe) => self.sub = None,
        }
    }

    /// 周期性维护：心跳 / 超时 / 凭据变化。驱动方约每秒调一次。
    pub fn on_tick(&mut self, now: Instant) {
        if self.closed {
            return;
        }
        self.check_credentials();
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

    /// 已认证的连接：凭据换代了（被新设备顶替 / 被撤销）就踢掉自己。
    fn check_credentials(&mut self) {
        if self.stage != Stage::Authed || self.creds.generation() == self.authed_gen {
            return;
        }
        let (_, change) = *self.changes.borrow();
        match change {
            Change::Superseded => self.close(ErrorCode::Superseded, "another device paired with this Host"),
            _ => self.close(ErrorCode::Revoked, "pairing was revoked"),
        }
    }

    fn on_hello(&mut self, versions: &[u32]) {
        let chosen = versions.iter().copied().filter(|v| SUPPORTED_VERSIONS.contains(v)).max();
        match chosen {
            Some(version) => {
                self.stage = Stage::Greeted;
                self.send(HostFrame::HelloOk {
                    version,
                    host: self.backend.host(),
                    auth: vec!["pair".into(), "token".into()],
                    limits: Limits { max_frame_bytes: MAX_FRAME_BYTES, max_in_flight: MAX_IN_FLIGHT },
                });
            }
            None => {
                self.send(HostFrame::HelloErr { code: ErrorCode::UnsupportedVersion, supported: SUPPORTED_VERSIONS.to_vec() });
                self.closed = true;
            }
        }
    }

    fn auth_failed(&mut self, code: ErrorCode, message: &str) {
        self.auth_failures += 1;
        self.send(HostFrame::AuthError { code, message: message.to_string() });
        if self.auth_failures >= MAX_AUTH_FAILURES {
            self.close(ErrorCode::TooManyAttempts, "too many failed attempts");
        }
    }

    fn on_pair(&mut self, code: &str) {
        match self.creds.pair(code) {
            Ok(token) => {
                self.authed_gen = self.creds.generation();
                self.stage = Stage::Authed;
                self.send(HostFrame::Paired {
                    device_id: self.creds.device_id().to_string(),
                    token,
                    granted: Catalog::granted(),
                });
            }
            Err(c) => {
                let msg = match c {
                    ErrorCode::ExpiredCode => "配对码已过期",
                    ErrorCode::TooManyAttempts => "配对码错误次数过多，已作废",
                    ErrorCode::BadCode => "配对码无效",
                    _ => "配对失败",
                };
                self.auth_failed(c, msg);
            }
        }
    }

    fn on_auth(&mut self, token: &str) {
        if self.creds.verify(token) {
            self.authed_gen = self.creds.generation();
            self.stage = Stage::Authed;
            self.send(HostFrame::Authed { granted: Catalog::granted() });
        } else {
            self.auth_failed(ErrorCode::BadToken, "token 无效");
        }
    }

    fn on_call(&mut self, id: u64, method: String, params: Value) {
        // 协议自己的方法：不转给 Host
        if method == LINK_DESCRIBE {
            return self.send(HostFrame::Result { id, value: Catalog::describe() });
        }
        if method == LINK_UNPAIR {
            self.send(HostFrame::Result { id, value: Value::Null });
            if let Err(e) = self.creds.revoke() {
                tracing::warn!("link.unpair: revoke failed: {e}");
            }
            // 凭据换代 → 紧跟在应答之后踢掉本连接（bye{revoked}）
            self.check_credentials();
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
