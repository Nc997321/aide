//! Aide Link 的 Host 端：**这台 Host 自己的手机网关**（协议见 `docs/aide-link-protocol.md`，
//! 实现在 `crates/aide-link`）。本机 Host 与 aide-host 守护进程共用这一份——手机配对的对象是 Host，
//! 不是某台桌面。
//!
//! - [`backend`]：把 Link 接到 Host 命令表与事件总线；
//! - [`vault`]：Host 的密钥 / 配对状态落在 Host 的密钥库；
//! - 本文件：服务生命周期（启停中继适配器）、配对二维码、状态；Host 设置面板通过 `link_*` 命令管它。
//!
//! 开关语义：**启用** = Host 出站注册到中继、等手机；生成配对二维码会自动启用。关闭 = 停止注册（已配对的
//! 手机公钥保留）。中继地址是**产品内置的固定值**（[`DEFAULT_RELAY_URL`]），不是用户设置——见该常量。

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

/// 手机与 Host 相遇的中继。**产品内置、用户不可改、界面不展示**（2026-10-01 定）：所有 Host（本机 / WSL / SSH）
/// 与手机都经同一个中继，配对二维码里带着它，手机端据此直连——不需要用户理解「中继」。中继是哑管道且不被信任
/// （端到端加密），写死不构成安全问题。
///
/// 唯一的覆盖口是环境变量 `AIDE_RELAY_URL`（开发 / 自建中继 / 集成测试用，进程启动时读一次）；没有设置项、
/// 没有 UI。旧版本存在 `settings.remote.relayUrl` 里的值**不再生效**（升级后需重新配对一次）。
pub const DEFAULT_RELAY_URL: &str = "wss://relay.aideai.store";

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
    /// 中继地址的覆盖值（见 [`DEFAULT_RELAY_URL`]）：构造时取自 `AIDE_RELAY_URL`，测试经
    /// [`set_relay_override`](Self::set_relay_override) 指向本地中继（不碰进程环境变量，免得并行测试互相踩）。
    relay_override: Mutex<Option<String>>,
}

impl Default for LinkService {
    fn default() -> Self {
        let from_env = std::env::var("AIDE_RELAY_URL").ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        Self { inner: Mutex::new(Inner::default()), relay_allowed: AtomicBool::new(true), relay_override: Mutex::new(from_env) }
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

    /// 覆盖中继地址（测试 / 前门用）；`None` 回到内置值。
    pub fn set_relay_override(&self, url: Option<String>) {
        *self.relay_override.lock().unwrap_or_else(PoisonError::into_inner) = url;
    }

    /// 此刻生效的中继地址：覆盖值，否则内置值。永不为空。
    fn relay_url(&self) -> String {
        self.relay_override.lock().unwrap_or_else(PoisonError::into_inner).clone().unwrap_or_else(|| DEFAULT_RELAY_URL.to_string())
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
        let url = self.relay_url();
        let want = (enabled && self.relay_allowed.load(Ordering::Relaxed)).then_some(url);
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
        })
    }

    pub fn set_enabled(&self, core: &Arc<Core>, enabled: bool) -> Result<LinkStatus, String> {
        SecretVault(Arc::clone(&core.settings)).set(K_ENABLED, if enabled { "1" } else { "0" })?;
        self.status(core)
    }

    /// 生成配对二维码（自动启用 Link）。
    pub fn create_offer(&self, core: &Arc<Core>) -> Result<OfferView, String> {
        let url = self.relay_url();
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

    /// 中继是产品内置的：没有任何设置能改它；只有覆盖口（环境变量 / 测试）能换。
    #[tokio::test]
    async fn the_relay_is_built_in_and_a_saved_setting_cannot_change_it() {
        let core = crate::test_core(Arc::new(NullSink));
        core.link.set_relay_override(None);
        assert_eq!(core.link.relay_url(), DEFAULT_RELAY_URL);
        // 旧版本留在设置里的值不再生效
        let run = crate::lookup("set_settings").unwrap();
        let _ = run(Arc::clone(&core), serde_json::json!({ "settings": { "remote": { "relayUrl": "wss://evil.example" } } })).await;
        assert_eq!(core.link.relay_url(), DEFAULT_RELAY_URL);
        let offer = PairingOffer::parse(&core.link.create_offer(&core).unwrap().uri).unwrap();
        assert!(matches!(offer.endpoint, Endpoint::Relay(ref u) if u == DEFAULT_RELAY_URL));
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
