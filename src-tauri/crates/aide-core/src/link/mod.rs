//! Aide Link 的 Host 端：**这台 Host 自己的手机网关**（协议见 `docs/aide-link-protocol.md`，
//! 实现在 `crates/aide-link`）。本机 Host 与 aide-host 守护进程共用这一份——手机配对的对象是 Host，
//! 不是某台桌面。
//!
//! - [`backend`]：把 Link 接到 Host 命令表与事件总线；
//! - [`vault`]：Host 的密钥 / 配对状态落在 Host 的密钥库；
//! - 本文件：服务生命周期（启停中继适配器）、配对二维码、状态；Host 设置面板通过 `link_*` 命令管它。
//!
//! 开关语义：**启用** = Host 出站注册到中继、等手机；生成配对二维码会自动启用。关闭 = 停止注册（已配对的
//! 手机公钥保留）。**中继地址没有出厂默认**（2026-10-05 起）：用户在「连接移动端」卡片里自己填，
//! 值是 Host 自持的链路状态（密钥库 `link/relayUrl`，与网关开关并列）——改地址即重连，手机需重新扫码。

pub mod backend;
pub mod vault;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use aide_link::secure::{Endpoint, PairingOffer};
use aide_link::transport::relay::{self, RelayStatus};
use aide_link::transport::LinkHost;
use aide_link::{Identity, Vault};
use serde::Serialize;
use tokio::task::JoinHandle;

use crate::Core;
use backend::CoreBackend;
use vault::SecretVault;

const K_ENABLED: &str = "link/enabled";

/// 用户填的中继地址存在 Host 密钥库的这个键上（与 [`K_ENABLED`] 并列）：link 自己的状态都在这本账里，
/// 不混进设置文档（那是偏好项，地址是链路状态）。缺失 / 空 = 用户还没配。
const K_RELAY_URL: &str = "link/relayUrl";

/// 设置面板看到的状态。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub enabled: bool,
    /// 此刻是否已在中继上注册（手机能找到这台 Host）。
    pub connected: bool,
    /// 本构建被刻意挡住不连中继（桌面 dev 构建，见 [`LinkService::set_relay_allowed`]）。
    /// 面板必须据此说明，否则「已启用」与「没连上」会同时出现在界面上。
    pub relay_suppressed: bool,
    pub last_error: String,
    pub device_id: String,
    pub host_name: String,
    /// 是否已配对了一台手机。
    pub paired: bool,
    /// 当前是否有一个有效的配对二维码。
    pub offer_active: bool,
    /// 此刻生效的中继地址；`None` = 用户还没配（没有出厂默认）。
    pub relay_url: Option<String>,
}

/// 生成配对二维码的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferView {
    /// 二维码里的 URI（`aide-link://pair?…`）。**含一次性密钥**：只给显示用，别记日志。
    pub uri: String,
    /// 同一内容的二维码，SVG（黑白，直接内联显示即可扫）。
    pub qr_svg: String,
    pub expires_at_unix: u64,
}

#[derive(Default)]
struct Inner {
    identity: Option<Arc<Identity>>,
    task: Option<(String, JoinHandle<()>)>,
    status: Arc<RelayStatus>,
}

/// Host 的 Link 网关服务。`Core` 持有一份；`start` 前什么都不做。
pub struct LinkService {
    inner: Mutex<Inner>,
    /// 前门是否允许本进程连中继（默认允许）。桌面 dev 构建关掉它：dev 与安装版共用同一份 Host 密钥库
    /// （device_id 同源），双双注册会在中继上互踢。
    relay_allowed: AtomicBool,
    /// 中继地址的覆盖值：**只为测试 / 前门**（[`set_relay_override`](Self::set_relay_override) 指向本地中继，
    /// 不碰进程环境变量，免得并行测试互相踩）。用户填的值不走这里，走密钥库（[`K_RELAY_URL`]）。
    relay_override: Mutex<Option<String>>,
}

impl Default for LinkService {
    fn default() -> Self {
        Self { inner: Mutex::new(Inner::default()), relay_allowed: AtomicBool::new(true), relay_override: Mutex::new(None) }
    }
}

/// 旧网关（桌面 v2）留在密钥库里的长期 token：协议已退役，留着只是一把没人用的钥匙，清掉。
const LEGACY_SECRETS: &[&str] = &["remote/token", "remote/tokenIssuedAt"];

impl LinkService {
    pub fn new() -> Self {
        Self::default()
    }

    /// 前门声明本进程是否允许连中继（须在 [`start`](Self::start) 之前）。
    pub fn set_relay_allowed(&self, allowed: bool) {
        self.relay_allowed.store(allowed, Ordering::Relaxed);
    }

    /// 覆盖中继地址（测试 / 前门用）；`None` 清掉覆盖（回落到用户值 / env）。
    pub fn set_relay_override(&self, url: Option<String>) {
        *self.relay_override.lock().unwrap_or_else(PoisonError::into_inner) = url;
    }

    /// 用户填的中继地址（Host 密钥库）；空串视为没填。
    fn saved_relay_url(core: &Core) -> Option<String> {
        SecretVault(Arc::clone(&core.settings)).get(K_RELAY_URL).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    }

    /// dev / 集成测试的种子（`AIDE_RELAY_URL`）：只在用户没填时兜底。
    fn env_relay_url() -> Option<String> {
        std::env::var("AIDE_RELAY_URL").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    }

    /// 此刻生效的中继地址：override（测试 / 前门） > 用户填的（密钥库） > `AIDE_RELAY_URL`。
    /// **没有出厂默认**——`None` = 还没配，连不了（面板据此提示、出码被拒）。
    fn relay_url(&self, core: &Core) -> Option<String> {
        self.relay_override
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .or_else(|| Self::saved_relay_url(core))
            .or_else(Self::env_relay_url)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Host 启动时调用（`host::start`）：载入 / 生成身份；若上次是启用状态就接上中继。
    pub fn start(&self, core: &Arc<Core>) {
        for key in LEGACY_SECRETS {
            let _ = core.settings.secrets().delete(key);
        }
        if let Err(e) = self.reconcile(core) {
            tracing::warn!("link: start failed: {e}");
        }
    }

    pub fn is_enabled(&self, core: &Core) -> bool {
        SecretVault(Arc::clone(&core.settings)).get(K_ENABLED).as_deref() == Some("1")
    }

    fn identity(&self, core: &Core) -> Result<Arc<Identity>, String> {
        let mut inner = self.lock();
        if let Some(id) = &inner.identity {
            return Ok(Arc::clone(id));
        }
        let id = Arc::new(Identity::load_or_create(Arc::new(SecretVault(Arc::clone(&core.settings))))?);
        inner.identity = Some(Arc::clone(&id));
        Ok(id)
    }

    /// 让「中继适配器任务」与（启用开关、中继地址）一致：该开就开、该关就关、地址变了就重连。
    /// 幂等；需要 tokio 运行时（任务用 `tokio::spawn`）。
    fn reconcile(&self, core: &Arc<Core>) -> Result<(), String> {
        let enabled = self.is_enabled(core);
        // 未配置地址 = 没有要跑的任务（面板会显示「未配置」）。
        let want = (enabled && self.relay_allowed.load(Ordering::Relaxed)).then(|| self.relay_url(core)).flatten();
        let identity = self.identity(core)?; // 总是备好身份（状态面板要显示 device_id）
        let mut inner = self.lock();
        match (&inner.task, &want) {
            (Some((running, _)), Some(w)) if running == w => {} // 已经对了
            _ => {
                if let Some((_, handle)) = inner.task.take() {
                    handle.abort();
                }
                inner.status = Arc::new(RelayStatus::default());
                if let Some(url) = want {
                    let host = LinkHost::new(Arc::new(CoreBackend::new(core, identity.device_id().to_string())), identity);
                    let handle = tokio::spawn(relay::run(host, url.clone(), Arc::clone(&inner.status)));
                    inner.task = Some((url, handle));
                }
            }
        }
        Ok(())
    }

    pub fn status(&self, core: &Arc<Core>) -> Result<LinkStatus, String> {
        self.reconcile(core)?;
        let identity = self.identity(core)?;
        let relay_url = self.relay_url(core); // 取在拿 inner 锁之前，避免与 reconcile 的加锁顺序交叉
        let inner = self.lock();
        Ok(LinkStatus {
            enabled: self.is_enabled(core),
            connected: inner.status.connected(),
            relay_suppressed: !self.relay_allowed.load(Ordering::Relaxed),
            last_error: inner.status.last_error(),
            device_id: identity.device_id().to_string(),
            host_name: backend::host_name(),
            paired: identity.authorized_phone().is_some(),
            offer_active: identity.offer_active(),
            relay_url,
        })
    }

    pub fn set_enabled(&self, core: &Arc<Core>, enabled: bool) -> Result<LinkStatus, String> {
        SecretVault(Arc::clone(&core.settings)).set(K_ENABLED, if enabled { "1" } else { "0" })?;
        self.status(core)
    }

    /// 设置 / 清除用户填的中继地址（空串 = 清除 = 未配置）。写密钥库后立即 `status()`——地址变了
    /// `reconcile` 会 abort 旧任务并按新地址重跑。**已配对的手机配的是旧地址，需重新扫码**。
    pub fn set_relay_url(&self, core: &Arc<Core>, raw: &str) -> Result<LinkStatus, String> {
        let vault = SecretVault(Arc::clone(&core.settings));
        match normalize_relay_url(raw)? {
            Some(url) => vault.set(K_RELAY_URL, &url)?,
            None => vault.remove(K_RELAY_URL)?,
        }
        self.status(core)
    }

    /// 生成配对二维码（自动启用 Link）。**没配中继地址就没法出码**：二维码里必须带地址。
    pub fn create_offer(&self, core: &Arc<Core>) -> Result<OfferView, String> {
        let Some(url) = self.relay_url(core) else {
            return Err("请先填写中继地址".to_string());
        };
        SecretVault(Arc::clone(&core.settings)).set(K_ENABLED, "1")?;
        self.reconcile(core)?;
        let identity = self.identity(core)?;
        let offer = identity.create_offer(Endpoint::Relay(url), &backend::host_name());
        Ok(offer_view(&offer))
    }

    pub fn cancel_offer(&self, core: &Core) -> Result<(), String> {
        self.identity(core)?.cancel_offer();
        Ok(())
    }

    /// 撤销已配对的手机（它的连接收到 `bye{revoked}`，之后 `resume` 得 `unauthorized`）。
    pub fn revoke(&self, core: &Core) -> Result<(), String> {
        self.identity(core)?.revoke()
    }
}

/// 归一化用户填的中继地址：trim；空 → `None`（未配置）；只收 `ws://` / `wss://` 且必须有主机名。
/// 路径补 `/ws` 由 `aide-link` 的 `ws_url()` 负责（`wss://h` 与 `wss://h/ws` 等价）。
fn normalize_relay_url(raw: &str) -> Result<Option<String>, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Ok(None);
    }
    let rest = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
        .ok_or_else(|| "中继地址需以 ws:// 或 wss:// 开头".to_string())?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || url.chars().any(char::is_whitespace) {
        return Err("中继地址缺少主机名".to_string());
    }
    Ok(Some(url.to_string()))
}

fn offer_view(offer: &PairingOffer) -> OfferView {
    let uri = offer.to_uri();
    OfferView { qr_svg: qr_svg(&uri), uri, expires_at_unix: offer.expires_at_unix }
}

/// 二维码 SVG：**黑白**（扫码器要对比度，不随主题变色——这是有意的例外）。
fn qr_svg(content: &str) -> String {
    use qrcode::render::svg;
    match qrcode::QrCode::new(content.as_bytes()) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(240, 240)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NullSink;
    use aide_link::secure::PairingOffer;

    /// 测试里把中继指到连不上的本地口，免得碰真中继。
    fn set_relay(core: &Arc<Core>, url: &str) {
        core.link.set_relay_override(Some(url.to_string()));
    }

    #[tokio::test]
    async fn status_before_any_setup_is_disabled_and_unconfigured() {
        let core = crate::test_core(Arc::new(NullSink));
        let s = core.link.status(&core).unwrap();
        assert!(!s.enabled && !s.connected && !s.paired && !s.offer_active);
        assert_eq!(s.relay_url, LinkService::env_relay_url(), "没有出厂默认：未填时只剩 dev/测试种子");
        assert_eq!(s.device_id.len(), 32);
        // 身份落进密钥库：再问一次还是同一个
        assert_eq!(core.link.status(&core).unwrap().device_id, s.device_id);
    }

    #[tokio::test]
    async fn an_offer_carries_a_scannable_qr_pointing_at_the_relay() {
        let core = crate::test_core(Arc::new(NullSink));
        set_relay(&core, "ws://127.0.0.1:1"); // 连不上也无妨：这里只验二维码内容
        let offer = core.link.create_offer(&core).unwrap();
        assert!(offer.qr_svg.starts_with("<?xml") || offer.qr_svg.contains("<svg"), "an SVG QR code");
        let parsed = PairingOffer::parse(&offer.uri).unwrap();
        let st = core.link.status(&core).unwrap();
        assert_eq!(parsed.device_id, st.device_id);
        assert!(matches!(parsed.endpoint, Endpoint::Relay(ref u) if u == "ws://127.0.0.1:1"));
        assert!(st.enabled && st.offer_active, "creating an offer enables the gateway and opens the offer");

        core.link.cancel_offer(&core).unwrap();
        assert!(!core.link.status(&core).unwrap().offer_active);
        core.link.set_enabled(&core, false).unwrap();
        assert!(!core.link.status(&core).unwrap().enabled);
    }

    /// 中继地址是**用户填的**（Host 密钥库）：设置文档改不了它（那是偏好项，不是链路状态）；
    /// 改它的唯一路径是 `set_relay_url`。**没有出厂默认**——没配就是 `None`（连不了、出不了码）。
    #[tokio::test]
    async fn the_relay_is_user_configured_and_a_saved_setting_cannot_change_it() {
        let core = crate::test_core(Arc::new(NullSink));
        core.link.set_relay_override(None);
        assert_eq!(core.link.relay_url(&core), LinkService::env_relay_url(), "没有出厂默认——未填时只剩 dev/测试种子");
        // 设置文档（含旧键）里的任何值都不影响中继地址
        let run = crate::lookup("set_settings").unwrap();
        let _ = run(Arc::clone(&core), serde_json::json!({ "settings": { "remote": { "relayUrl": "wss://evil.example" } } })).await;
        assert_eq!(core.link.relay_url(&core), LinkService::env_relay_url());
        // 用户填的值：落密钥库 → status 回显 → 二维码带上
        let st = core.link.set_relay_url(&core, "wss://relay.example:8443").unwrap();
        assert_eq!(st.relay_url.as_deref(), Some("wss://relay.example:8443"));
        let offer = PairingOffer::parse(&core.link.create_offer(&core).unwrap().uri).unwrap();
        assert!(matches!(offer.endpoint, Endpoint::Relay(ref u) if u == "wss://relay.example:8443"));
        // 清空 = 未配置：状态回落到种子，且（无种子时）出码被拒
        let st = core.link.set_relay_url(&core, "   ").unwrap();
        assert_eq!(st.relay_url, LinkService::env_relay_url());
        if LinkService::env_relay_url().is_none() {
            assert!(core.link.create_offer(&core).is_err(), "没地址出不了码");
        }
    }

    /// 非法地址一律拒绝，且什么都不改（权威校验在 Rust；前端只做最轻的提示）。
    #[tokio::test]
    async fn an_invalid_relay_url_is_rejected_and_changes_nothing() {
        let core = crate::test_core(Arc::new(NullSink));
        core.link.set_relay_override(Some("wss://good.example".to_string()));
        for bad in ["http://x", "relay.example.com", "wss://", "wss:// /x"] {
            assert!(core.link.set_relay_url(&core, bad).is_err(), "{bad} 应被拒");
            assert_eq!(core.link.relay_url(&core).as_deref(), Some("wss://good.example"), "{bad} 不该改动现状");
        }
    }

    /// dev 构建的闸门：被挡住时即使启用也不连中继，并如实告诉面板（否则「已启用」却「没连上」）。
    #[tokio::test]
    async fn a_suppressed_build_never_registers_with_the_relay_and_says_so() {
        let core = crate::test_core(Arc::new(NullSink));
        core.link.set_relay_allowed(false);
        set_relay(&core, "ws://127.0.0.1:1");
        core.link.set_enabled(&core, true).unwrap();
        let st = core.link.status(&core).unwrap();
        assert!(st.enabled && st.relay_suppressed && !st.connected);
        assert!(core.link.lock().task.is_none(), "no relay task may be running");
        core.link.set_relay_allowed(true);
        assert!(!core.link.status(&core).unwrap().relay_suppressed);
        assert!(core.link.lock().task.is_some(), "allowed again → the gateway registers");
    }

    /// 旧网关留下的 token 在启动时清掉。
    #[tokio::test]
    async fn start_removes_the_legacy_gateway_secrets() {
        let core = crate::test_core(Arc::new(NullSink));
        core.settings.secrets().set("remote/token", "old").unwrap();
        core.settings.secrets().set("remote/tokenIssuedAt", "1").unwrap();
        core.link.start(&core);
        assert!(core.settings.secrets().get("remote/token").unwrap().is_none());
        assert!(core.settings.secrets().get("remote/tokenIssuedAt").unwrap().is_none());
    }

    #[tokio::test]
    async fn revoke_clears_the_paired_phone() {
        let core = crate::test_core(Arc::new(NullSink));
        set_relay(&core, "ws://127.0.0.1:1");
        let offer = PairingOffer::parse(&core.link.create_offer(&core).unwrap().uri).unwrap();
        let identity = core.link.identity(&core).unwrap();
        let phone = aide_link::secure::generate_keypair();
        identity.commit_pairing(&phone.public, &offer.psk).unwrap();
        assert!(core.link.status(&core).unwrap().paired);
        core.link.revoke(&core).unwrap();
        assert!(!core.link.status(&core).unwrap().paired);
    }
}
