//! Link 网关的 Host 命令：**Host 设置面板管的是「这台 Host」的手机网关**（Host 窗口里连的是哪台，
//! 配对的就是哪台）。这些命令是 Host 自己的能力，**不对手机开放**（不在 `aide-link` 的目录里）。

use std::sync::Arc;

use crate::link::{LinkStatus, OfferView};
use crate::registry::{blocking, Command as HostCommand};
use crate::{command, Core};

pub static COMMANDS: &[HostCommand] = &[
    command!("link_status", link_status),
    command!("link_set_enabled", link_set_enabled),
    command!("link_create_offer", link_create_offer),
    command!("link_cancel_offer", link_cancel_offer),
    command!("link_revoke", link_revoke),
];

async fn link_status(core: Arc<Core>, _: crate::commands::NoArgs) -> Result<LinkStatus, String> {
    blocking(move || core.link.status(&core)).await
}

#[derive(serde::Deserialize)]
struct SetEnabledArgs {
    enabled: bool,
}

async fn link_set_enabled(core: Arc<Core>, a: SetEnabledArgs) -> Result<LinkStatus, String> {
    blocking(move || core.link.set_enabled(&core, a.enabled)).await
}

async fn link_create_offer(core: Arc<Core>, _: crate::commands::NoArgs) -> Result<OfferView, String> {
    blocking(move || core.link.create_offer(&core)).await
}

async fn link_cancel_offer(core: Arc<Core>, _: crate::commands::NoArgs) -> Result<(), String> {
    blocking(move || core.link.cancel_offer(&core)).await
}

async fn link_revoke(core: Arc<Core>, _: crate::commands::NoArgs) -> Result<(), String> {
    blocking(move || core.link.revoke(&core)).await
}
