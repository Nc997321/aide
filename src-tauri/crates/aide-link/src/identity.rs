//! Host 的身份与配对状态：Host 自己的密钥对、当前的配对二维码（一次性密钥）、已配对的那台手机的公钥。
//!
//! **单设备模型（刻意设计，改动前先确认）**：一个 Host 同一时刻只认**一把**手机公钥——新设备配对成功
//! = 覆盖旧公钥 = 旧设备的连接收到 `bye{superseded}`。配对二维码泄露后恶意设备若能静默共存是安全降级，
//! 所以宁可让「后来者顶掉前者」**可见**。
//!
//! 配对凭据是**高熵的一次性密钥**（32 字节，二维码里带），不是可被爆破的短码：
//! - 一次性：配对成功即作废；10 分钟过期；同一时刻只有一个有效二维码；
//! - 握手失败**不烧**二维码（否则知道 `device_id` 的人可以反复发垃圾握手把它烧掉）；
//! - 手机的**静态密钥就是它之后的凭据**，没有 token 可偷。
//!
//! 持久化经 [`Vault`] 端口（Host 一侧决定放哪：桌面 = 钥匙串，远程 Host = `~/.aide/secrets.json`）；
//! 本模块不碰文件系统。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rand::Rng;
use tokio::sync::watch;

use crate::frame::ErrorCode;
use crate::secure::{b64, unb64_32, Endpoint, Keypair, PairingOffer};

/// 配对二维码有效期。
pub const OFFER_TTL: Duration = Duration::from_secs(600);

const K_DEVICE: &str = "link/device_id";
const K_HOST_KEY: &str = "link/host_key";
const K_PHONE: &str = "link/phone_key";

/// 密钥 / 配对状态的持久化端口（键值，值是文本）。
pub trait Vault: Send + Sync + 'static {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

/// 内存实现（测试 / 不要求跨重启保留的场景）。
#[derive(Default)]
pub struct MemoryVault(Mutex<HashMap<String, String>>);

impl Vault for MemoryVault {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).insert(key.into(), value.into());
        Ok(())
    }
    fn remove(&self, key: &str) -> Result<(), String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).remove(key);
        Ok(())
    }
}

/// 配对状态变化的原因（连着的会话据此决定是否被踢、以什么原因）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    None,
    /// 新设备配对，旧公钥作废。
    Superseded,
    /// 用户在 Host 上撤销 / 设备自己 unpair。
    Revoked,
}

struct Offer {
    psk: [u8; 32],
    expires_at: Instant,
}

pub struct Identity {
    vault: Arc<dyn Vault>,
    device_id: String,
    host: Keypair,
    offer: Mutex<Option<Offer>>,
    /// 每次 commit_pairing / revoke 加一；会话记下自己建立时的值，变了就查原因。
    generation: AtomicU64,
    changes: watch::Sender<(u64, Change)>,
}

/// 由私钥推出整个密钥对。
pub fn keypair_from_private(private: [u8; 32]) -> Keypair {
    let secret = x25519_dalek::StaticSecret::from(private);
    let public = x25519_dalek::PublicKey::from(&secret);
    Keypair { private, public: *public.as_bytes() }
}

fn random_32() -> [u8; 32] {
    rand::thread_rng().gen()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Identity {
    /// 取 Host 身份；第一次运行时生成 `device_id` 与密钥对并存下。
    pub fn load_or_create(vault: Arc<dyn Vault>) -> Result<Self, String> {
        let device_id = match vault.get(K_DEVICE) {
            Some(d) if d.len() == 32 && d.bytes().all(|b| b.is_ascii_hexdigit()) => d,
            _ => {
                let bytes: [u8; 16] = rand::thread_rng().gen();
                let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                vault.set(K_DEVICE, &id)?;
                id
            }
        };
        let private = match vault.get(K_HOST_KEY).and_then(|s| unb64_32(&s)) {
            Some(k) => k,
            None => {
                let k = random_32();
                vault.set(K_HOST_KEY, &b64(&k))?;
                k
            }
        };
        Ok(Self::from_parts(vault, device_id, private))
    }

    /// 用给定的 `device_id` 与私钥组装（一致性测试要确定的值；不落盘）。
    pub fn from_parts(vault: Arc<dyn Vault>, device_id: String, host_private: [u8; 32]) -> Self {
        let (changes, _) = watch::channel((0, Change::None));
        Self {
            vault,
            device_id,
            host: keypair_from_private(host_private),
            offer: Mutex::new(None),
            generation: AtomicU64::new(0),
            changes,
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn host_public(&self) -> [u8; 32] {
        self.host.public
    }

    pub(crate) fn host_private(&self) -> &[u8; 32] {
        &self.host.private
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// 订阅配对状态变化（会话用）。
    pub fn watch(&self) -> watch::Receiver<(u64, Change)> {
        self.changes.subscribe()
    }

    /// 已配对的手机公钥。
    pub fn authorized_phone(&self) -> Option<[u8; 32]> {
        self.vault.get(K_PHONE).and_then(|s| unb64_32(&s))
    }

    pub fn is_authorized(&self, phone_public: &[u8; 32]) -> bool {
        self.authorized_phone().is_some_and(|p| constant_time_eq(&p, phone_public))
    }

    /// 生成配对二维码内容（替换掉任何尚未用掉的旧二维码）。`endpoint` 是手机该怎么够到这台 Host。
    pub fn create_offer(&self, endpoint: Endpoint, name: &str) -> PairingOffer {
        self.create_offer_at(endpoint, name, Instant::now(), SystemTime::now())
    }

    fn create_offer_at(&self, endpoint: Endpoint, name: &str, now: Instant, wall: SystemTime) -> PairingOffer {
        let psk = random_32();
        *self.offer.lock().unwrap_or_else(PoisonError::into_inner) = Some(Offer { psk, expires_at: now + OFFER_TTL });
        PairingOffer {
            endpoint,
            device_id: self.device_id.clone(),
            host_public: self.host.public,
            psk,
            name: name.to_string(),
            expires_at_unix: wall.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) + OFFER_TTL.as_secs(),
        }
    }

    /// 撤掉当前二维码（用户关了配对对话框）。
    pub fn cancel_offer(&self) {
        *self.offer.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    pub fn offer_active(&self) -> bool {
        self.offer_psk().is_some()
    }

    /// 当前有效二维码的一次性密钥（`pair` 握手用它做 psk）。过期 / 没有 → None。
    pub fn offer_psk(&self) -> Option<[u8; 32]> {
        self.offer_psk_at(Instant::now())
    }

    fn offer_psk_at(&self, now: Instant) -> Option<[u8; 32]> {
        let mut o = self.offer.lock().unwrap_or_else(PoisonError::into_inner);
        match o.as_ref() {
            Some(x) if now < x.expires_at => Some(x.psk),
            Some(_) => {
                *o = None; // 过期的顺手清掉
                None
            }
            None => None,
        }
    }

    /// 配对确认（手机用握手派生的密钥发来了第一个有效帧）：二维码作废、记下这把手机公钥。
    /// `psk` 必须仍是当前有效二维码的密钥——并发的第二台手机（同一个码）会在这里被拒绝。
    pub fn commit_pairing(&self, phone_public: &[u8; 32], psk: &[u8; 32]) -> Result<(), ErrorCode> {
        self.commit_pairing_at(phone_public, psk, Instant::now())
    }

    fn commit_pairing_at(&self, phone_public: &[u8; 32], psk: &[u8; 32], now: Instant) -> Result<(), ErrorCode> {
        {
            let mut o = self.offer.lock().unwrap_or_else(PoisonError::into_inner);
            match o.as_ref() {
                Some(x) if now < x.expires_at && constant_time_eq(&x.psk, psk) => *o = None, // 一次性
                _ => return Err(ErrorCode::NoPairingOffer),
            }
        }
        let previous = self.authorized_phone();
        self.vault.set(K_PHONE, &b64(phone_public)).map_err(|_| ErrorCode::Internal)?;
        let superseded = previous.is_some_and(|p| !constant_time_eq(&p, phone_public));
        self.bump(if superseded { Change::Superseded } else { Change::None });
        Ok(())
    }

    /// 把配对状态钉成指定值（**只给一致性测试装置用**：向量要确定的手机公钥 / 一次性密钥）。
    pub fn seed_for_test(&self, phone: Option<[u8; 32]>, offer_psk: Option<[u8; 32]>) {
        if let Some(p) = phone {
            let _ = self.vault.set(K_PHONE, &b64(&p));
        }
        *self.offer.lock().unwrap_or_else(PoisonError::into_inner) =
            offer_psk.map(|psk| Offer { psk, expires_at: Instant::now() + OFFER_TTL });
    }

    /// 撤销已配对设备（Host 设置面板 / 设备自己 `link.unpair`）。
    pub fn revoke(&self) -> Result<(), String> {
        self.vault.remove(K_PHONE)?;
        self.bump(Change::Revoked);
        Ok(())
    }

    fn bump(&self, change: Change) {
        let g = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.changes.send((g, change));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure::generate_keypair;

    fn identity() -> Identity {
        Identity::load_or_create(Arc::new(MemoryVault::default())).unwrap()
    }

    /// 同一个 Vault 起第二次，身份不变（重启后手机不用重新配对）。
    #[test]
    fn identity_is_created_once_and_persists() {
        let vault: Arc<dyn Vault> = Arc::new(MemoryVault::default());
        let a = Identity::load_or_create(Arc::clone(&vault)).unwrap();
        let b = Identity::load_or_create(vault).unwrap();
        assert_eq!(a.device_id(), b.device_id());
        assert_eq!(a.host_public(), b.host_public());
        assert_eq!(a.device_id().len(), 32);
        assert_ne!(identity().host_public(), a.host_public(), "each Host has its own key");
    }

    #[test]
    fn the_offer_carries_everything_the_phone_needs_and_is_single_use() {
        let id = identity();
        assert!(id.offer_psk().is_none(), "no offer until one is created");
        let offer = id.create_offer(Endpoint::Relay("wss://relay.example".into()), "devbox");
        assert_eq!(offer.device_id, id.device_id());
        assert_eq!(offer.host_public, id.host_public());
        assert_eq!(id.offer_psk(), Some(offer.psk));

        let phone = generate_keypair();
        id.commit_pairing(&phone.public, &offer.psk).unwrap();
        assert!(id.is_authorized(&phone.public));
        assert!(!id.offer_active(), "burned on use");
        assert_eq!(id.commit_pairing(&phone.public, &offer.psk), Err(ErrorCode::NoPairingOffer));
    }

    #[test]
    fn a_wrong_or_expired_secret_never_pairs() {
        let id = identity();
        let t0 = Instant::now();
        let offer = id.create_offer_at(Endpoint::Relay("wss://r".into()), "n", t0, SystemTime::now());
        let phone = generate_keypair();
        assert_eq!(id.commit_pairing_at(&phone.public, &[0u8; 32], t0), Err(ErrorCode::NoPairingOffer));
        assert!(id.offer_active(), "a failed attempt does not burn the offer (that would be a DoS)");
        assert_eq!(
            id.commit_pairing_at(&phone.public, &offer.psk, t0 + OFFER_TTL + Duration::from_secs(1)),
            Err(ErrorCode::NoPairingOffer)
        );
        assert!(id.authorized_phone().is_none());
    }

    /// 单设备：新手机配对覆盖旧公钥，旧的失效；连着的会话从 watch 看到「被顶替」。
    #[test]
    fn a_new_pairing_supersedes_the_previous_phone() {
        let id = identity();
        let mut rx = id.watch();
        let (a, b) = (generate_keypair(), generate_keypair());
        let o = id.create_offer(Endpoint::Relay("r".into()), "n");
        id.commit_pairing(&a.public, &o.psk).unwrap();
        assert_eq!(rx.borrow_and_update().1, Change::None, "first pairing supersedes nobody");
        let o = id.create_offer(Endpoint::Relay("r".into()), "n");
        id.commit_pairing(&b.public, &o.psk).unwrap();
        assert!(!id.is_authorized(&a.public));
        assert!(id.is_authorized(&b.public));
        assert_eq!(rx.borrow_and_update().1, Change::Superseded);
    }

    /// 同一台手机重新扫码（换了二维码）不算「被顶替」。
    #[test]
    fn re_pairing_the_same_phone_supersedes_nobody() {
        let id = identity();
        let mut rx = id.watch();
        let a = generate_keypair();
        for _ in 0..2 {
            let o = id.create_offer(Endpoint::Relay("r".into()), "n");
            id.commit_pairing(&a.public, &o.psk).unwrap();
        }
        assert_eq!(rx.borrow_and_update().1, Change::None);
    }

    #[test]
    fn revoke_clears_the_phone_and_announces_it() {
        let id = identity();
        let mut rx = id.watch();
        let a = generate_keypair();
        let o = id.create_offer(Endpoint::Relay("r".into()), "n");
        id.commit_pairing(&a.public, &o.psk).unwrap();
        id.revoke().unwrap();
        assert!(!id.is_authorized(&a.public));
        assert_eq!(rx.borrow_and_update().1, Change::Revoked);
    }

    /// 新二维码顶掉旧二维码：旧的密钥不能再用。
    #[test]
    fn a_new_offer_replaces_the_old_one() {
        let id = identity();
        let old = id.create_offer(Endpoint::Relay("r".into()), "n");
        let new = id.create_offer(Endpoint::Relay("r".into()), "n");
        assert_ne!(old.psk, new.psk);
        let phone = generate_keypair();
        assert_eq!(id.commit_pairing(&phone.public, &old.psk), Err(ErrorCode::NoPairingOffer));
        assert!(id.commit_pairing(&phone.public, &new.psk).is_ok());
    }
}
