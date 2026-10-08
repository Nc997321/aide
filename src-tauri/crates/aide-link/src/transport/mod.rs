//! 传输适配器：把「WebSocket 上的文本消息」搬进 [`crate::Connection`]（协议栈本身与传输无关）。
//!
//! - [`direct`]：Host 自己监听一个 WebSocket 端口（局域网 / Tailscale / 测试 Host），手机直连；
//! - [`relay`]：Host 主动连中继、用 `device_id` 注册，手机经中继来找它（Host 不用开端口）。
//!
//! 两者共用 [`driver::drive`]：读消息 → `Connection`；`Connection` 的输出帧 → 写消息；每秒一个 tick。

use std::sync::Arc;

use tokio::sync::mpsc::UnboundedSender;

use crate::backend::Backend;
use crate::connection::Connection;
use crate::identity::Identity;
use crate::secure::WireFrame;

pub mod direct;
pub mod driver;
pub mod relay;

/// 一台 Host 的 Link 网关：后端（命令 / 事件）+ 身份（密钥 / 配对状态）。克隆很便宜。
#[derive(Clone)]
pub struct LinkHost {
    pub backend: Arc<dyn Backend>,
    pub identity: Arc<Identity>,
}

impl LinkHost {
    pub fn new(backend: Arc<dyn Backend>, identity: Arc<Identity>) -> Self {
        Self { backend, identity }
    }

    pub fn connection(&self, wire: UnboundedSender<WireFrame>) -> Connection {
        Connection::new(Arc::clone(&self.backend), Arc::clone(&self.identity), wire)
    }
}
