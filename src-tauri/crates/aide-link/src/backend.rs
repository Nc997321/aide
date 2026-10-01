//! Host 一侧的两个端口：连接会话（[`crate::session::Session`]）只认它们，不认识 aide-core / aide-host。
//! 实现在 aide-host（调命令表、接事件中心）；测试用 [`crate::testkit`] 的假实现。

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;

use crate::catalog::LinkPolicy;
use crate::frame::{HostFrame, HostInfo, Since};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// 订阅句柄：**drop = 退订**。
pub trait Subscription: Send {}

pub trait Backend: Send + Sync + 'static {
    /// 这台 Host 的画像（`hello_ok` 里给客户端）。
    fn host(&self) -> HostInfo;

    /// 对远程客户端生效的策略（如 `send_message` 的默认权限模式）。每次调用时取，设置改了立即生效。
    fn policy(&self) -> LinkPolicy;

    /// 执行一个 Host 命令（命令名 = 命令表里的名字，`params` 已经过 [`crate::Catalog::prepare`]）。
    /// 二进制结果由实现包成 `{"$bytes":"<base64>"}`。目录白名单已由会话挡过，实现不必再挡。
    fn call(&self, method: &str, params: Value) -> BoxFuture<Result<Value, String>>;

    /// 把本连接接到 Host 的事件流。**契约**（客户端依赖这个顺序）：
    /// 1. 先向 `sink` 送一帧 [`HostFrame::Subscribed`]；
    /// 2. 再按序送回放的事件（`since` 给了且 epoch 对得上时，`seq` 大于它的、且符合订阅的）；
    /// 3. 之后是实时事件——1→2→3 在一把锁里完成，不丢、不重、不乱序；
    /// 4. 只送目录里公开的事件（[`crate::Catalog::is_event_exposed`]）；`sessions` 非空时，
    ///    session-routed 的事件只送属于这些会话的。
    ///
    /// 返回的句柄被 drop 即退订。
    fn attach_events(
        &self,
        sink: UnboundedSender<HostFrame>,
        sessions: Option<Vec<String>>,
        since: Option<Since>,
    ) -> Box<dyn Subscription>;
}
