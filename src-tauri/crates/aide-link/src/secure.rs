//! 安全通道：Link 帧在中继 / 网络上只以密文出现（Noise，X25519 + ChaChaPoly + SHA256）。
//!
//! 为什么：中继是哑管道，但它**能看到**途经的一切；没有这一层，它抄走凭据就等于拿到 Host 的
//! 控制权（agent 有 shell 工具）。有了这一层，中继被攻破 / 作恶，也只能看到密文与长度。
//!
//! **两种握手**（均由手机发起，Host 是响应方；Host 的静态公钥手机事先知道）：
//!
//! | 模式 | Noise 模式 | 用途 | 认证 |
//! |---|---|---|---|
//! | `pair` | `Noise_IKpsk2_25519_ChaChaPoly_SHA256` | 首次配对：手机扫二维码后发起 | psk = 二维码里的一次性密钥；Host 公钥来自二维码，所以没有中间人 |
//! | `resume` | `Noise_IK_25519_ChaChaPoly_SHA256` | 之后每次重连 | Host 只认已配对的那把手机公钥 |
//!
//! 没有配对码、没有 token：**手机的静态密钥就是它的凭据**。prologue = `aide-link/1:` + Host 的
//! `device_id`（把通道绑到这台 Host 与协议版本上）。握手消息的 payload 恒为空。
//!
//! **线上形状**（都是 WebSocket 文本消息里的 JSON，中继看得到、看不懂）：
//! `sc_init` / `sc_resp` / `sc_err` 是握手；之后双向都是 `sc`，每条携带一段密文，一个 Link 帧
//! 的明文（JSON）按 [`CHUNK`] 切块、逐块加密，末块 `last:true`。

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use snow::{Builder, HandshakeState, TransportState};

use crate::frame::ErrorCode;

pub const NOISE_PAIR: &str = "Noise_IKpsk2_25519_ChaChaPoly_SHA256";
pub const NOISE_RESUME: &str = "Noise_IK_25519_ChaChaPoly_SHA256";

/// 明文切块大小。Noise 单条消息上限 65535 字节（含 16 字节 tag），取 32 KiB 留足余量。
pub const CHUNK: usize = 32 * 1024;
/// 一个 Link 帧重组后的上限（与 `frame::MAX_FRAME_BYTES` 同值，防内存被撑爆）。
pub const MAX_ASSEMBLED: usize = crate::frame::MAX_FRAME_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Pair,
    Resume,
}

impl Mode {
    fn pattern(self) -> &'static str {
        match self {
            Mode::Pair => NOISE_PAIR,
            Mode::Resume => NOISE_RESUME,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Keypair {
    pub private: [u8; 32],
    pub public: [u8; 32],
}

impl std::fmt::Debug for Keypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Keypair(public={})", b64(&self.public))
    }
}

pub fn generate_keypair() -> Keypair {
    let kp = Builder::new(NOISE_RESUME.parse().expect("static pattern"))
        .generate_keypair()
        .expect("keypair");
    Keypair {
        private: kp.private.try_into().expect("32 bytes"),
        public: kp.public.try_into().expect("32 bytes"),
    }
}

/// 把通道绑到这台 Host 和协议版本上。两端必须一致，否则握手失败。
pub fn prologue(device_id: &str) -> Vec<u8> {
    format!("aide-link/1:{device_id}").into_bytes()
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64_32(s: &str) -> Option<[u8; 32]> {
    URL_SAFE_NO_PAD.decode(s).ok()?.try_into().ok()
}

// ── 线上的握手 / 数据帧 ──────────────────────────────────────────────────────

/// 握手与加密数据的外层帧（明文 JSON，经 WebSocket 文本消息）。内层才是 [`crate::frame`] 的 Link 帧。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireFrame {
    /// 手机 → Host：发起握手。`msg` = Noise 第一条消息（标准 base64）。
    ScInit { versions: Vec<u32>, mode: Mode, msg: String },
    /// Host → 手机：握手第二条消息。
    ScResp { version: u32, msg: String },
    /// Host → 手机：握手被拒（随后断开）。
    ScErr { code: ErrorCode, message: String },
    /// 双向：一块密文（标准 base64）；`last` = 一个 Link 帧的末块。
    Sc { c: String, last: bool },
}

impl WireFrame {
    pub const TYPES: &'static [&'static str] = &["sc_init", "sc_resp", "sc_err", "sc"];
}

pub fn encode_bytes(b: &[u8]) -> String {
    STANDARD.encode(b)
}

pub fn decode_bytes(s: &str) -> Option<Vec<u8>> {
    STANDARD.decode(s).ok()
}

// ── 握手 ─────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum HandshakeError {
    /// 消息无法按 Noise 解析 / 认证失败（含 psk 不对、prologue 不对）。
    Bad(String),
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeError::Bad(m) => write!(f, "{m}"),
        }
    }
}

fn bad(e: snow::Error) -> HandshakeError {
    HandshakeError::Bad(e.to_string())
}

/// Host 一侧的握手：先读第一条消息、拿到对方静态公钥（由调用方决定认不认），再写第二条。
pub struct Responder {
    hs: HandshakeState,
    pub remote_static: [u8; 32],
}

impl Responder {
    /// `psk` 仅 `pair` 模式需要（二维码里的一次性密钥）。
    pub fn read_first(
        mode: Mode,
        host_secret: &[u8; 32],
        device_id: &str,
        psk: Option<&[u8; 32]>,
        msg1: &[u8],
        fixed_ephemeral: Option<&[u8; 32]>,
    ) -> Result<Self, HandshakeError> {
        let pro = prologue(device_id);
        let mut b = Builder::new(mode.pattern().parse().map_err(bad)?)
            .local_private_key(host_secret)
            .prologue(&pro);
        if mode == Mode::Pair {
            b = b.psk(2, psk.ok_or_else(|| HandshakeError::Bad("pair needs a psk".into()))?);
        }
        if let Some(e) = fixed_ephemeral {
            b = b.fixed_ephemeral_key_for_testing_only(e); // 只给一致性向量用
        }
        let mut hs = b.build_responder().map_err(bad)?;
        let mut payload = [0u8; 64];
        hs.read_message(msg1, &mut payload).map_err(bad)?;
        let remote_static = hs
            .get_remote_static()
            .and_then(|s| <[u8; 32]>::try_from(s).ok())
            .ok_or_else(|| HandshakeError::Bad("no initiator static key".into()))?;
        Ok(Self { hs, remote_static })
    }

    /// 写第二条消息，握手完成，进入传输态。
    pub fn finish(mut self) -> Result<(Vec<u8>, Transport), HandshakeError> {
        let mut out = vec![0u8; 256];
        let n = self.hs.write_message(&[], &mut out).map_err(bad)?;
        out.truncate(n);
        let t = self.hs.into_transport_mode().map_err(bad)?;
        Ok((out, Transport::new(t)))
    }
}

/// 手机一侧的握手（参考实现：测试 / 一致性向量用；手机端按同一规约自己实现）。
pub struct Initiator {
    hs: HandshakeState,
}

impl Initiator {
    /// 返回第一条消息。`psk` 仅 `pair` 模式。`fixed_ephemeral` 只给一致性向量用。
    pub fn start(
        mode: Mode,
        own: &Keypair,
        host_public: &[u8; 32],
        device_id: &str,
        psk: Option<&[u8; 32]>,
        fixed_ephemeral: Option<&[u8; 32]>,
    ) -> Result<(Vec<u8>, Self), HandshakeError> {
        let pro = prologue(device_id);
        let mut b = Builder::new(mode.pattern().parse().map_err(bad)?)
            .local_private_key(&own.private)
            .remote_public_key(host_public)
            .prologue(&pro);
        if mode == Mode::Pair {
            b = b.psk(2, psk.ok_or_else(|| HandshakeError::Bad("pair needs a psk".into()))?);
        }
        if let Some(e) = fixed_ephemeral {
            b = b.fixed_ephemeral_key_for_testing_only(e);
        }
        let mut hs = b.build_initiator().map_err(bad)?;
        let mut out = vec![0u8; 256];
        let n = hs.write_message(&[], &mut out).map_err(bad)?;
        out.truncate(n);
        Ok((out, Self { hs }))
    }

    /// 读第二条消息；psk 不对 / Host 不是二维码里那台，在这里失败。
    pub fn finish(mut self, msg2: &[u8]) -> Result<Transport, HandshakeError> {
        let mut payload = [0u8; 64];
        self.hs.read_message(msg2, &mut payload).map_err(bad)?;
        Ok(Transport::new(self.hs.into_transport_mode().map_err(bad)?))
    }
}

// ── 传输态 ───────────────────────────────────────────────────────────────────

/// 握手后的加密通道（两个方向各自一条严格递增的 nonce——WebSocket 有序，丢 / 乱序即解密失败）。
pub struct Transport {
    state: TransportState,
    /// 正在重组的 Link 帧明文。
    assembling: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// 密文无法解密 / 认证失败 / base64 坏了：通道已不可信，应断开。
    Corrupt,
    /// 一个帧重组后超过上限。
    TooLarge,
}

impl Transport {
    fn new(state: TransportState) -> Self {
        Self { state, assembling: Vec::new() }
    }

    /// 把一个 Link 帧的明文加密成若干 `sc` 帧（按块）。
    pub fn seal(&mut self, plaintext: &[u8]) -> Vec<WireFrame> {
        let mut chunks: Vec<&[u8]> = plaintext.chunks(CHUNK).collect();
        if chunks.is_empty() {
            chunks.push(&[]);
        }
        let n = chunks.len();
        chunks
            .into_iter()
            .enumerate()
            .map(|(i, chunk)| {
                let mut out = vec![0u8; chunk.len() + 16];
                let len = self.state.write_message(chunk, &mut out).expect("noise encrypt");
                out.truncate(len);
                WireFrame::Sc { c: encode_bytes(&out), last: i + 1 == n }
            })
            .collect()
    }

    /// 收一块密文；凑齐一个 Link 帧时返回它的明文。
    pub fn open(&mut self, c: &str, last: bool) -> Result<Option<Vec<u8>>, OpenError> {
        let ct = decode_bytes(c).ok_or(OpenError::Corrupt)?;
        if ct.len() < 16 || ct.len() > 65535 {
            return Err(OpenError::Corrupt);
        }
        let mut out = vec![0u8; ct.len()];
        let n = self.state.read_message(&ct, &mut out).map_err(|_| OpenError::Corrupt)?;
        self.assembling.extend_from_slice(&out[..n]);
        if self.assembling.len() > MAX_ASSEMBLED {
            return Err(OpenError::TooLarge);
        }
        Ok(last.then(|| std::mem::take(&mut self.assembling)))
    }
}

// ── 配对二维码 ───────────────────────────────────────────────────────────────

/// 二维码里的内容：手机据此知道「连谁、怎么连、信谁的公钥、用哪把一次性密钥」。
///
/// 形如 `aide-link://pair?v=1&relay=wss%3A%2F%2F…&id=<32 hex>&pk=<43 b64url>&psk=<43 b64url>&n=<名字>&exp=<unix 秒>`。
/// `psk` 一次性、10 分钟有效；不要把它存起来或写进日志。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingOffer {
    pub relay: String,
    pub device_id: String,
    pub host_public: [u8; 32],
    pub psk: [u8; 32],
    pub name: String,
    pub expires_at_unix: u64,
}

const URI_PREFIX: &str = "aide-link://pair?";

impl PairingOffer {
    pub fn to_uri(&self) -> String {
        use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
        format!(
            "{URI_PREFIX}v=1&relay={}&id={}&pk={}&psk={}&n={}&exp={}",
            utf8_percent_encode(&self.relay, NON_ALPHANUMERIC),
            self.device_id,
            b64(&self.host_public),
            b64(&self.psk),
            utf8_percent_encode(&self.name, NON_ALPHANUMERIC),
            self.expires_at_unix
        )
    }

    pub fn parse(uri: &str) -> Result<Self, String> {
        use percent_encoding::percent_decode_str;
        let query = uri.strip_prefix(URI_PREFIX).ok_or("not an aide-link pairing URI")?;
        let mut v = None;
        let (mut relay, mut id, mut pk, mut psk, mut name, mut exp) = (None, None, None, None, None, None);
        for pair in query.split('&') {
            let (k, val) = pair.split_once('=').ok_or("malformed query")?;
            let dec = || percent_decode_str(val).decode_utf8().map(|s| s.into_owned()).map_err(|e| e.to_string());
            match k {
                "v" => v = Some(val.to_string()),
                "relay" => relay = Some(dec()?),
                "id" => id = Some(val.to_string()),
                "pk" => pk = Some(val.to_string()),
                "psk" => psk = Some(val.to_string()),
                "n" => name = Some(dec()?),
                "exp" => exp = Some(val.to_string()),
                _ => {} // 向前兼容：忽略未知键
            }
        }
        if v.as_deref() != Some("1") {
            return Err("unsupported pairing URI version".into());
        }
        let device_id = id.ok_or("missing id")?;
        if device_id.len() != 32 || !device_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("bad device id".into());
        }
        Ok(Self {
            relay: relay.ok_or("missing relay")?,
            device_id,
            host_public: unb64_32(&pk.ok_or("missing pk")?).ok_or("bad pk")?,
            psk: unb64_32(&psk.ok_or("missing psk")?).ok_or("bad psk")?,
            name: name.unwrap_or_default(),
            expires_at_unix: exp.ok_or("missing exp")?.parse().map_err(|_| "bad exp")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV: &str = "00112233445566778899aabbccddeeff";

    fn pair(mode: Mode, psk_client: Option<[u8; 32]>, psk_host: Option<[u8; 32]>) -> Result<(Transport, Transport), String> {
        let host = generate_keypair();
        let phone = generate_keypair();
        let (m1, init) = Initiator::start(mode, &phone, &host.public, DEV, psk_client.as_ref(), None).map_err(|e| e.to_string())?;
        let resp = Responder::read_first(mode, &host.private, DEV, psk_host.as_ref(), &m1, None).map_err(|e| e.to_string())?;
        assert_eq!(resp.remote_static, phone.public, "the Host learns the phone's static key from msg1");
        let (m2, host_t) = resp.finish().map_err(|e| e.to_string())?;
        let phone_t = init.finish(&m2).map_err(|e| e.to_string())?;
        Ok((phone_t, host_t))
    }

    fn roundtrip(from: &mut Transport, to: &mut Transport, plain: &[u8]) -> Vec<u8> {
        let mut got = None;
        for f in from.seal(plain) {
            let WireFrame::Sc { c, last } = f else { panic!() };
            got = to.open(&c, last).unwrap();
        }
        got.expect("last chunk completes the frame")
    }

    #[test]
    fn resume_handshake_then_both_directions_carry_frames() {
        let (mut phone, mut host) = pair(Mode::Resume, None, None).unwrap();
        assert_eq!(roundtrip(&mut phone, &mut host, br#"{"type":"hello"}"#), br#"{"type":"hello"}"#);
        assert_eq!(roundtrip(&mut host, &mut phone, b"back"), b"back");
    }

    #[test]
    fn pair_handshake_needs_the_same_one_time_secret() {
        let psk = [7u8; 32];
        assert!(pair(Mode::Pair, Some(psk), Some(psk)).is_ok());
        // 手机扫到的密钥与 Host 的不一致：在手机读第二条消息时失败（Host 因此也永远收不到有效帧）
        let err = pair(Mode::Pair, Some([1u8; 32]), Some([2u8; 32])).err().unwrap();
        assert!(!err.is_empty());
    }

    /// prologue 绑定 device_id：连错 Host（device_id 不同）握手失败。
    #[test]
    fn handshake_is_bound_to_the_host_identity() {
        let host = generate_keypair();
        let phone = generate_keypair();
        let (m1, _) = Initiator::start(Mode::Resume, &phone, &host.public, DEV, None, None).unwrap();
        assert!(Responder::read_first(Mode::Resume, &host.private, "ffffffffffffffffffffffffffffffff", None, &m1, None).is_err());
        // 公钥不是这台 Host 的（二维码被换过 / 连错了机器）
        let imposter = generate_keypair();
        assert!(Responder::read_first(Mode::Resume, &imposter.private, DEV, None, &m1, None).is_err());
    }

    #[test]
    fn large_frames_are_chunked_and_reassembled() {
        let (mut phone, mut host) = pair(Mode::Resume, None, None).unwrap();
        let big: Vec<u8> = (0..(CHUNK * 3 + 17)).map(|i| (i % 251) as u8).collect();
        let frames = phone.seal(&big);
        assert_eq!(frames.len(), 4);
        assert!(matches!(frames[0], WireFrame::Sc { last: false, .. }));
        assert!(matches!(frames[3], WireFrame::Sc { last: true, .. }));
        let mut got = None;
        for f in frames {
            let WireFrame::Sc { c, last } = f else { panic!() };
            got = host.open(&c, last).unwrap();
        }
        assert_eq!(got.unwrap(), big);
    }

    #[test]
    fn tampered_replayed_or_reordered_ciphertext_is_rejected() {
        let (mut phone, mut host) = pair(Mode::Resume, None, None).unwrap();
        let f1 = phone.seal(b"one");
        let f2 = phone.seal(b"two");
        let (WireFrame::Sc { c: c1, .. }, WireFrame::Sc { c: c2, .. }) = (&f1[0], &f2[0]) else { panic!() };
        // 乱序：先给第二条
        assert_eq!(host.open(c2, true), Err(OpenError::Corrupt));
        // 篡改一个字节
        let mut raw = decode_bytes(c1).unwrap();
        raw[0] ^= 1;
        assert_eq!(host.open(&encode_bytes(&raw), true), Err(OpenError::Corrupt));
        // 垃圾
        assert_eq!(host.open("!!!", true), Err(OpenError::Corrupt));
    }

    #[test]
    fn pairing_uri_roundtrips_and_rejects_garbage() {
        let host = generate_keypair();
        let offer = PairingOffer {
            relay: "wss://relay.example.com/aide?x=1&y=2".into(),
            device_id: DEV.into(),
            host_public: host.public,
            psk: [9u8; 32],
            name: "我的 devbox & co".into(),
            expires_at_unix: 1_800_000_000,
        };
        let uri = offer.to_uri();
        assert!(uri.starts_with("aide-link://pair?v=1&"));
        assert!(uri.len() < 400, "must fit a comfortable QR code: {}", uri.len());
        assert_eq!(PairingOffer::parse(&uri).unwrap(), offer);
        for bad in ["", "http://x", "aide-link://pair?v=2&id=x", "aide-link://pair?v=1&relay=r&id=zz&pk=a&psk=b&exp=1"] {
            assert!(PairingOffer::parse(bad).is_err(), "{bad}");
        }
        // 未知键向前兼容
        assert!(PairingOffer::parse(&format!("{uri}&future=1")).is_ok());
    }
}
