//! Aide Link 的 Host 端：**这台 Host 自己的手机网关**（协议见 `docs/aide-link-protocol.md`，
//! 实现在 `crates/aide-link`）。本机 Host 与 aide-host 守护进程共用这一份——手机配对的对象是 Host，
//! 不是某台桌面。
//!
//! - [`backend`]：把 Link 接到 Host 命令表与事件总线；
//! - [`vault`]：Host 的密钥 / 配对状态落在 Host 的密钥库；
//! - 本文件：服务生命周期（启停中继适配器）、配对二维码、状态；Host 设置面板通过 `link_*` 命令管它。
//!
//! 开关语义：**启用** = Host 出站注册到中继、等手机；生成配对二维码会自动启用。关闭 = 停止注册（已配对的
//! 手机公钥保留）。中继地址沿用设置里的 `remote.relayUrl`（与旧网关同一个中继）。

pub mod backend;
pub mod vault;

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

/// 设置面板看到的状态。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub enabled: bool,
    /// 设置里是否配了中继地址（没配就没法配对 / 注册）。
    pub relay_configured: bool,
    pub relay_url: String,
    /// 此刻是否已在中继上注册（手机能找到这台 Host）。
    pub connected: bool,
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
#[derive(Default)]
pub struct LinkService {
    inner: Mutex<Inner>,
}

impl LinkService {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Host 启动时调用（`host::start`）：载入 / 生成身份；若上次是启用状态就接上中继。
    pub fn start(&self, core: &Arc<Core>) {
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

    fn relay_url(core: &Core) -> String {
        crate::app_settings::public_settings(&core.settings)
            .map(|s| s.remote.relay_url.trim().to_string())
            .unwrap_or_default()
    }

    /// 让「中继适配器任务」与（启用开关、中继地址）一致：该开就开、该关就关、地址变了就重连。
    /// 幂等；需要 tokio 运行时（任务用 `tokio::spawn`）。
    fn reconcile(&self, core: &Arc<Core>) -> Result<(), String> {
        let enabled = self.is_enabled(core);
        let url = Self::relay_url(core);
        let want = (enabled && !url.is_empty()).then_some(url);
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
        let url = Self::relay_url(core);
        Ok(LinkStatus {
            enabled: self.is_enabled(core),
            relay_configured: !url.is_empty(),
            relay_url: url,
            connected: inner.status.connected(),
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

    /// 生成配对二维码（自动启用 Link）。需要先在设置里配好中继地址。
    pub fn create_offer(&self, core: &Arc<Core>) -> Result<OfferView, String> {
        let url = Self::relay_url(core);
        if url.is_empty() {
            return Err("请先在设置里配置中继地址（远程控制 → 中继）".into());
        }
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

    async fn set_relay(core: &Arc<Core>, url: &str) {
        let args = serde_json::json!({ "settings": { "remote": { "relayUrl": url } } });
        let run = crate::lookup("set_settings").unwrap();
        run(Arc::clone(core), args).await.unwrap();
    }

    #[tokio::test]
    async fn status_before_any_setup_is_disabled_and_unconfigured() {
        let core = crate::test_core(Arc::new(NullSink));
        let s = core.link.status(&core).unwrap();
        assert!(!s.enabled && !s.relay_configured && !s.connected && !s.paired && !s.offer_active);
        assert_eq!(s.device_id.len(), 32);
        // 身份落进密钥库：再问一次还是同一个
        assert_eq!(core.link.status(&core).unwrap().device_id, s.device_id);
    }

    #[tokio::test]
    async fn an_offer_needs_a_relay_and_then_carries_a_scannable_qr() {
        let core = crate::test_core(Arc::new(NullSink));
        let err = core.link.create_offer(&core).unwrap_err();
        assert!(err.contains("中继"), "{err}");

        set_relay(&core, "ws://127.0.0.1:1").await; // 连不上也无妨：这里只验二维码内容
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

    #[tokio::test]
    async fn revoke_clears_the_paired_phone() {
        let core = crate::test_core(Arc::new(NullSink));
        set_relay(&core, "ws://127.0.0.1:1").await;
        let offer = PairingOffer::parse(&core.link.create_offer(&core).unwrap().uri).unwrap();
        let identity = core.link.identity(&core).unwrap();
        let phone = aide_link::secure::generate_keypair();
        identity.commit_pairing(&phone.public, &offer.psk).unwrap();
        assert!(core.link.status(&core).unwrap().paired);
        core.link.revoke(&core).unwrap();
        assert!(!core.link.status(&core).unwrap().paired);
    }
}
