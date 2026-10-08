//! 一条**线上连接**的完整协议栈：安全通道握手 → 加密传输 → [`Session`]。传输适配器（中继 / 直连
//! WebSocket）只需要做三件事：
//!
//! 1. 收到一条文本消息 → [`Connection::on_wire_text`]；
//! 2. 隔一小段时间 → [`Connection::on_tick`]；
//! 3. 把 [`Connection::new`] 时给的 `wire` 通道里的 [`WireFrame`] 序列化成 JSON 文本发出去。
//!    [`Connection::is_closed`] 为真后，先 [`Connection::flush`]（等最后一个 `bye` 加密完），
//!    把通道里剩下的发完，再关连接。
//!
//! 握手规则（Host 强制）：
//! - 第一帧必须是 `sc_init`；版本无交集 → `sc_err{unsupported_version}`；
//! - `resume`：手机公钥不是已配对的那把 → `sc_err{unauthorized}`；
//! - `pair`：Host 当前没有有效二维码 → `sc_err{no_pairing_offer}`；握手完成后**不立即记下手机**，
//!   等手机用派生出的密钥发来第一个有效帧才算数（`commit_pairing`）——扫错 / 一次性密钥不对的
//!   一方永远发不出有效帧，Host 因此不会被骗去配对；
//! - 握手 15 s 内没完成 → `sc_err{timeout}`。

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::task::JoinHandle;

use crate::backend::Backend;
use crate::frame::{ErrorCode, HostFrame, SUPPORTED_VERSIONS};
use crate::identity::Identity;
use crate::secure::{decode_bytes, encode_bytes, Mode, OpenError, Responder, Transport, WireFrame};
use crate::session::Session;

pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// 一条外层文本消息的上限（一块密文 base64 后约 44 KiB；留余量）。
pub const MAX_WIRE_TEXT: usize = 128 * 1024;

type Shared = Arc<Mutex<Transport>>;

enum Stage {
    /// 等 `sc_init`。
    Init,
    /// `pair` 握手已回了第二条消息，等手机的第一个有效帧来确认。
    Confirming { transport: Shared, phone: [u8; 32], psk: [u8; 32], version: u32 },
    Open { transport: Shared, session: Box<Session> },
    Dead,
}

/// **一条 `Connection` = 一次手机连接 = 一条专属的线上腿**（直连 WebSocket / 中继桥接腿，生灭同步）。
/// 它不负责「这条腿后来换了手机」——腿从不被复用；腿一断，驱动循环返回、`Connection` 被丢弃，
/// 会话 / 总线订阅 / 加密泵随之一起结束（见 [`Drop`]）。
pub struct Connection {
    backend: Arc<dyn Backend>,
    identity: Arc<Identity>,
    wire: UnboundedSender<WireFrame>,
    stage: Stage,
    started: Instant,
    pump: Option<JoinHandle<()>>,
}

impl Connection {
    pub fn new(backend: Arc<dyn Backend>, identity: Arc<Identity>, wire: UnboundedSender<WireFrame>) -> Self {
        Self { backend, identity, wire, stage: Stage::Init, started: Instant::now(), pump: None }
    }

    pub fn is_closed(&self) -> bool {
        match &self.stage {
            Stage::Dead => true,
            Stage::Open { session, .. } => session.is_closed(),
            _ => false,
        }
    }

    /// 等已排队的 Link 帧（尤其是最后的 `bye`）加密并进入 `wire` 通道。关连接前调用。
    pub async fn flush(&mut self) {
        if let Some(p) = self.pump.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), p).await;
        }
    }

    fn reject(&mut self, code: ErrorCode, message: &str) {
        let _ = self.wire.send(WireFrame::ScErr { code, message: message.to_string() });
        self.stage = Stage::Dead;
    }

    /// 收到一条线上的文本消息。
    pub async fn on_wire_text(&mut self, text: &str) {
        if text.len() > MAX_WIRE_TEXT {
            if !(matches!(self.stage, Stage::Dead) || self.is_closed()) {
                self.reject(ErrorCode::TooLarge, "wire message too large");
            }
            return;
        }
        let parsed = serde_json::from_str::<WireFrame>(text);
        if matches!(self.stage, Stage::Dead) || self.is_closed() {
            return;
        }
        let Ok(frame) = parsed else {
            return self.reject(ErrorCode::ProtocolError, "expected an sc_init / sc frame");
        };
        match (&mut self.stage, frame) {
            (Stage::Init, WireFrame::ScInit { versions, mode, msg }) => self.on_init(&versions, mode, &msg),
            (Stage::Init, _) => self.reject(ErrorCode::ProtocolError, "first frame must be `sc_init`"),
            (Stage::Confirming { transport, .. }, WireFrame::Sc { c, last }) => {
                let opened = transport.lock().unwrap_or_else(PoisonError::into_inner).open(&c, last);
                match opened {
                    Ok(None) => {}
                    Ok(Some(plain)) => self.confirm_pairing(plain).await,
                    Err(_) => self.reject(ErrorCode::BadHandshake, "pairing confirmation failed"),
                }
            }
            (Stage::Open { transport, session }, WireFrame::Sc { c, last }) => {
                let opened = transport.lock().unwrap_or_else(PoisonError::into_inner).open(&c, last);
                match opened {
                    Ok(None) => {}
                    Ok(Some(plain)) => match String::from_utf8(plain) {
                        Ok(t) => session.on_text(&t).await,
                        Err(_) => session.on_text("\u{0}").await, // 非 UTF-8 → 交给会话按乱码处理
                    },
                    Err(OpenError::TooLarge) => self.reject(ErrorCode::TooLarge, "frame exceeds the size limit"),
                    Err(OpenError::Corrupt) => self.reject(ErrorCode::BadHandshake, "ciphertext rejected; channel is no longer trusted"),
                }
            }
            (_, _) => self.reject(ErrorCode::ProtocolError, "unexpected frame for this stage"),
        }
    }

    pub fn on_tick(&mut self, now: Instant) {
        match &mut self.stage {
            Stage::Init | Stage::Confirming { .. } => {
                if now.duration_since(self.started) >= HANDSHAKE_TIMEOUT {
                    self.reject(ErrorCode::Timeout, "handshake timed out");
                }
            }
            Stage::Open { session, .. } => session.on_tick(now),
            Stage::Dead => {}
        }
    }

    fn on_init(&mut self, versions: &[u32], mode: Mode, msg: &str) {
        let Some(version) = versions.iter().copied().filter(|v| SUPPORTED_VERSIONS.contains(v)).max() else {
            return self.reject(ErrorCode::UnsupportedVersion, "no common protocol version");
        };
        let Some(msg1) = decode_bytes(msg) else {
            return self.reject(ErrorCode::BadHandshake, "handshake message is not base64");
        };
        let psk = match mode {
            Mode::Pair => match self.identity.offer_psk() {
                Some(p) => Some(p),
                None => return self.reject(ErrorCode::NoPairingOffer, "this Host has no pairing offer open"),
            },
            Mode::Resume => None,
        };
        let responder = match Responder::read_first(mode, self.identity.host_private(), self.identity.device_id(), psk.as_ref(), &msg1, None) {
            Ok(r) => r,
            Err(e) => return self.reject(ErrorCode::BadHandshake, &e.to_string()),
        };
        let phone = responder.remote_static;
        if mode == Mode::Resume && !self.identity.is_authorized(&phone) {
            return self.reject(ErrorCode::Unauthorized, "this device is not paired with this Host");
        }
        let (msg2, transport) = match responder.finish() {
            Ok(x) => x,
            Err(e) => return self.reject(ErrorCode::BadHandshake, &e.to_string()),
        };
        let _ = self.wire.send(WireFrame::ScResp { version, msg: encode_bytes(&msg2) });
        let transport: Shared = Arc::new(Mutex::new(transport));
        match psk {
            None => self.open(transport, version),
            Some(psk) => self.stage = Stage::Confirming { transport, phone, psk, version },
        }
    }

    /// 配对确认：手机用派生密钥发来了第一个有效帧。
    async fn confirm_pairing(&mut self, first_plain: Vec<u8>) {
        let Stage::Confirming { transport, phone, psk, version } = std::mem::replace(&mut self.stage, Stage::Dead) else {
            return;
        };
        if let Err(code) = self.identity.commit_pairing(&phone, &psk) {
            return self.reject(code, "the pairing offer is no longer valid");
        }
        self.open(transport, version);
        if let Stage::Open { session, .. } = &mut self.stage {
            if let Ok(t) = String::from_utf8(first_plain) {
                session.on_text(&t).await;
            }
        }
    }

    /// 进入传输态：建会话，起「Link 帧 → 加密 → 线上」的泵。
    fn open(&mut self, transport: Shared, version: u32) {
        let (tx, mut rx) = unbounded_channel::<HostFrame>();
        let session = Session::new(Arc::clone(&self.backend), Arc::clone(&self.identity), version, tx);
        let wire = self.wire.clone();
        let t = Arc::clone(&transport);
        self.pump = Some(tokio::spawn(async move {
            while let Some(f) = rx.recv().await {
                let terminal = matches!(f, HostFrame::Bye { .. });
                if let Ok(json) = serde_json::to_vec(&f) {
                    let frames = t.lock().unwrap_or_else(PoisonError::into_inner).seal(&json);
                    for w in frames {
                        if wire.send(w).is_err() {
                            return;
                        }
                    }
                }
                if terminal {
                    break;
                }
            }
        }));
        self.stage = Stage::Open { transport, session: Box::new(session) };
    }
}

impl Drop for Connection {
    /// 腿没了就别再往线上封帧：泵是独立任务，丢掉 `JoinHandle` 不会停它。
    fn drop(&mut self) {
        if let Some(p) = self.pump.take() {
            p.abort();
        }
    }
}
