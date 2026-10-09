//! 发布渠道端口：「镜像仓库里发布过哪些版本」。
//!
//! 用途只有一个：服务端出了新版时，界面能告诉用户（知识库服务装在用户自己的服务器上，
//! 以前没有任何渠道让他知道有新版）。选最新那版、缓存都在 `domain::release`，这里只取数据。
//!
//! 实现有两个：查 OCI/Docker registry（`adapter::registry`），或没配仓库时的 `Disabled`
//! （内网离线部署）。

use std::future::Future;
use std::pin::Pin;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// 异步端口（网络 IO）。盒装 future：要放进 `Arc<dyn …>`，`async fn` in trait 不是 dyn 兼容的。
pub trait ReleaseChannel: Send + Sync {
    /// 镜像仓库地址（`host/namespace/name`），给界面拼升级命令用。None = 没配发布渠道。
    fn repo(&self) -> Option<&str>;

    /// 仓库上的全部标签（含 `stable` 这类非版本号标签，由调用方筛）。
    fn tags(&self) -> BoxFut<'_, Vec<String>>;
}

/// 没配发布渠道（`KB_RELEASE_REPO=` 置空）：不查、不提示。
pub struct Disabled;

impl ReleaseChannel for Disabled {
    fn repo(&self) -> Option<&str> {
        None
    }
    fn tags(&self) -> BoxFut<'_, Vec<String>> {
        Box::pin(async { Err("没有配置发布渠道（KB_RELEASE_REPO）".to_string()) })
    }
}
