//! 配对与长期 token。
//!
//! **单设备模型（刻意设计，改动前先确认）**：一个 Host 同一时刻只认一个配对设备——新设备配对 =
//! 覆盖旧 token = 旧设备被踢（连着的旧连接收到 `bye{superseded}`）。配对码泄露后恶意设备若能静默
//! 共存是安全降级，所以宁可让「后来者顶掉前者」可见。
//!
//! 在旧协议（v2）基础上收紧的几点：
//! - 配对码**一次性**：配对成功即作废，换新码；
//! - 配对码有**错误次数上限**（[`MAX_CODE_FAILURES`]）：撞满即作废换新码——6 位码经中继可被在线爆破，
//!   10 分钟窗口 + 无上限不够；
//! - 码与 token 的比较**常量时间**。
//!
//! token 的持久化经 [`TokenVault`] 端口（Host 一侧决定放哪：桌面 = 钥匙串，远程 Host =
//! `~/.aide/secrets.json`）；本模块不碰文件系统。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use rand::Rng;
use tokio::sync::watch;

use crate::frame::ErrorCode;

/// 配对码有效期。
pub const CODE_TTL: Duration = Duration::from_secs(600);
/// 同一枚配对码允许错几次（含）；再错作废并换新码。
pub const MAX_CODE_FAILURES: u32 = 5;

/// token 的持久化端口。
pub trait TokenVault: Send + Sync + 'static {
    fn load(&self) -> Option<String>;
    fn store(&self, token: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// 内存实现（测试 / 不要求跨重启保留的场景）。
#[derive(Default)]
pub struct MemoryVault(Mutex<Option<String>>);

impl TokenVault for MemoryVault {
    fn load(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
    fn store(&self, token: &str) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(token.to_string());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }
}

/// 凭据变化的原因（连着的会话据此决定是否被踢、以什么原因）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    None,
    /// 新设备配对，旧 token 作废。
    Superseded,
    /// 用户在 Host 上撤销 / 设备自己 unpair。
    Revoked,
}

struct Pairing {
    code: String,
    expires_at: Instant,
    failures: u32,
}

pub struct Credentials {
    vault: Arc<dyn TokenVault>,
    /// Host 在中继上的身份（`Paired.device_id`）。
    device_id: String,
    pairing: Mutex<Pairing>,
    /// 每次 pair / revoke 加一；会话记下自己认证时的值，变了就查原因。
    generation: AtomicU64,
    changes: watch::Sender<(u64, Change)>,
}

impl Credentials {
    pub fn new(vault: Arc<dyn TokenVault>, device_id: String) -> Self {
        let (changes, _) = watch::channel((0, Change::None));
        Self {
            vault,
            device_id,
            pairing: Mutex::new(Pairing { code: String::new(), expires_at: Instant::now(), failures: 0 }),
            generation: AtomicU64::new(0),
            changes,
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn has_token(&self) -> bool {
        self.vault.load().is_some()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// 订阅凭据变化（会话用）。
    pub fn watch(&self) -> watch::Receiver<(u64, Change)> {
        self.changes.subscribe()
    }

    /// 当前有效的配对码；过期 / 未生成则换新。
    pub fn pairing_code(&self) -> String {
        self.pairing_code_at(Instant::now())
    }

    fn pairing_code_at(&self, now: Instant) -> String {
        let mut p = self.pairing.lock().unwrap_or_else(PoisonError::into_inner);
        if p.code.is_empty() || now >= p.expires_at {
            Self::rotate(&mut p, now);
        }
        p.code.clone()
    }

    /// 把配对码钉成指定值（**只给一致性测试用**：向量里的码必须是确定的）。
    pub fn force_pairing_code(&self, code: &str) {
        let mut p = self.pairing.lock().unwrap_or_else(PoisonError::into_inner);
        p.code = code.to_string();
        p.expires_at = Instant::now() + CODE_TTL;
        p.failures = 0;
    }

    /// 主动换码（Host 设置面板「刷新」）。
    pub fn refresh_code(&self) -> String {
        let mut p = self.pairing.lock().unwrap_or_else(PoisonError::into_inner);
        Self::rotate(&mut p, Instant::now());
        p.code.clone()
    }

    fn rotate(p: &mut Pairing, now: Instant) {
        let n: u32 = rand::thread_rng().gen_range(0..1_000_000);
        p.code = format!("{n:06}");
        p.expires_at = now + CODE_TTL;
        p.failures = 0;
    }

    /// 用配对码换 token。成功：签发新 token（覆盖旧的 = 踢旧设备）、码作废。
    pub fn pair(&self, code: &str) -> Result<String, ErrorCode> {
        self.pair_at(code, Instant::now())
    }

    fn pair_at(&self, code: &str, now: Instant) -> Result<String, ErrorCode> {
        {
            let mut p = self.pairing.lock().unwrap_or_else(PoisonError::into_inner);
            if p.code.is_empty() || now >= p.expires_at {
                return Err(ErrorCode::ExpiredCode);
            }
            if !constant_time_eq(p.code.as_bytes(), code.as_bytes()) {
                p.failures += 1;
                if p.failures >= MAX_CODE_FAILURES {
                    Self::rotate(&mut p, now); // 撞满：这枚码作废，Host 上显示新的
                    return Err(ErrorCode::TooManyAttempts);
                }
                return Err(ErrorCode::BadCode);
            }
            Self::rotate(&mut p, now); // 一次性：用过即换
        }
        let token = new_token();
        let superseded = self.vault.load().is_some();
        self.vault.store(&token).map_err(|_| ErrorCode::Internal)?;
        self.bump(if superseded { Change::Superseded } else { Change::None });
        Ok(token)
    }

    pub fn verify(&self, token: &str) -> bool {
        match self.vault.load() {
            Some(t) => constant_time_eq(t.as_bytes(), token.as_bytes()),
            None => false,
        }
    }

    /// 撤销已配对设备（Host 设置面板 / 设备自己 `link.unpair`）。
    pub fn revoke(&self) -> Result<(), String> {
        self.vault.clear()?;
        self.bump(Change::Revoked);
        Ok(())
    }

    fn bump(&self, change: Change) {
        let g = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.changes.send((g, change));
    }
}

fn new_token() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 常量时间比较（长度不同直接不等——长度本身不是秘密）。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> Credentials {
        Credentials::new(Arc::new(MemoryVault::default()), "dev-1".into())
    }

    #[test]
    fn pairing_issues_a_token_that_verifies_and_burns_the_code() {
        let c = creds();
        let code = c.pairing_code();
        assert_eq!(code.len(), 6);
        let token = c.pair(&code).unwrap();
        assert_eq!(token.len(), 64);
        assert!(c.verify(&token));
        assert!(!c.verify("nope"));
        // 一次性：同一个码不能再用，Host 上已换新码
        assert_ne!(c.pairing_code(), code);
        assert_eq!(c.pair(&code), Err(ErrorCode::BadCode));
    }

    /// 单设备：新设备配对覆盖旧 token，旧 token 立即失效；连着的会话能从 watch 看到「被顶替」。
    #[test]
    fn a_new_pairing_supersedes_the_previous_device() {
        let c = creds();
        let mut rx = c.watch();
        let first = c.pair(&c.pairing_code()).unwrap();
        assert_eq!(rx.borrow_and_update().1, Change::None, "first pairing supersedes nobody");
        let second = c.pair(&c.pairing_code()).unwrap();
        assert!(!c.verify(&first), "old device's token is dead");
        assert!(c.verify(&second));
        assert_eq!(rx.borrow_and_update().1, Change::Superseded);
    }

    #[test]
    fn revoke_clears_the_token_and_announces_it() {
        let c = creds();
        let mut rx = c.watch();
        let t = c.pair(&c.pairing_code()).unwrap();
        c.revoke().unwrap();
        assert!(!c.verify(&t));
        assert!(!c.has_token());
        assert_eq!(rx.borrow_and_update().1, Change::Revoked);
    }

    /// 在线爆破防线：同一枚码错满 5 次作废换新，之后连正确的旧码也不行。
    #[test]
    fn code_is_burned_after_too_many_wrong_guesses() {
        let c = creds();
        let code = c.pairing_code();
        let wrong = if code == "000000" { "111111" } else { "000000" };
        for _ in 0..MAX_CODE_FAILURES - 1 {
            assert_eq!(c.pair(wrong), Err(ErrorCode::BadCode));
        }
        assert_eq!(c.pair(wrong), Err(ErrorCode::TooManyAttempts));
        assert_ne!(c.pairing_code(), code, "burned code was replaced");
        assert!(c.pair(&code).is_err(), "even the right old code no longer works");
        assert!(!c.has_token());
    }

    #[test]
    fn expired_code_is_rejected_and_refreshed_on_demand() {
        let c = creds();
        let t0 = Instant::now();
        let code = c.pairing_code_at(t0);
        assert_eq!(c.pair_at(&code, t0 + CODE_TTL + Duration::from_secs(1)), Err(ErrorCode::ExpiredCode));
        // 过期后再取码 = 新码
        let fresh = c.pairing_code_at(t0 + CODE_TTL + Duration::from_secs(1));
        assert!(c.pair_at(&fresh, t0 + CODE_TTL + Duration::from_secs(2)).is_ok());
    }

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
