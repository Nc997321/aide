//! Aide Link：Host 与远程客户端（手机）之间的协议。叙述版见 `docs/aide-link-protocol.md`。
//!
//! 目录：
//! - [`frame`]：线上的帧与错误码（协议的唯一真相源）
//! - [`catalog`]：暴露目录（手机能调什么 / 收什么——整张表即远程暴露面）
//! - [`secure`]：安全通道（Noise 握手 / 加密传输 / 配对二维码内容）
//! - [`identity`]：Host 的密钥、配对二维码、已配对的手机公钥（单设备）
//! - [`backend`]：Host 一侧的两个端口（命令执行、事件订阅）
//! - [`session`]：一条已认证连接上的 Link 状态机（传输 / 加密无关）
//! - [`connection`]：一条线上连接的完整协议栈（握手 → 加密 → 会话），传输适配器只接它
//! - [`conformance`] / [`testkit`]：一致性用例的执行器与假 Host（`tests/fixtures/` 里的对话是
//!   语言无关的向量，手机端实现可以用同一批向量自测）
//!
//! 传输适配器（中继客户端 / 直连 WebSocket）不在本 crate 的协议核心里：它们只是把「文本消息」搬进
//! [`Connection`]。

pub mod backend;
pub mod catalog;
pub mod client;
pub mod conformance;
pub mod connection;
pub mod frame;
pub mod identity;
pub mod secure;
pub mod session;
pub mod testkit;
#[cfg(feature = "transport")]
pub mod transport;

pub use identity::{Change, Identity, MemoryVault, Vault};
pub use backend::{Backend, BoxFuture, Subscription};
pub use catalog::{Catalog, LinkPolicy};
pub use frame::{ClientFrame, ErrorCode, HostFrame, HostInfo, Since, Subscribed};
pub use connection::Connection;
pub use session::Session;
