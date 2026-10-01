//! Aide Link：Host 与远程客户端（手机）之间的协议。叙述版见 `docs/aide-link-protocol.md`。
//!
//! 目录：
//! - [`frame`]：线上的帧与错误码（协议的唯一真相源）
//! - [`catalog`]：暴露目录（手机能调什么 / 收什么——整张表即远程暴露面）
//! - [`auth`]：单设备配对与 token
//! - [`backend`]：Host 一侧的两个端口（命令执行、事件订阅）
//! - [`session`]：一条连接的状态机（传输无关）
//! - [`conformance`] / [`testkit`]：一致性用例的执行器与假 Host（`tests/fixtures/` 里的对话是
//!   语言无关的向量，手机端实现可以用同一批向量自测）
//!
//! 传输适配器（中继客户端等）不在本 crate 的协议核心里：它们只是把「文本消息」搬进
//! [`Session`]，见 `transport/`。

pub mod auth;
pub mod backend;
pub mod catalog;
pub mod conformance;
pub mod frame;
pub mod session;
pub mod testkit;

pub use auth::{Change, Credentials, MemoryVault, TokenVault};
pub use backend::{Backend, BoxFuture, Subscription};
pub use catalog::{Catalog, LinkPolicy};
pub use frame::{ClientFrame, ErrorCode, HostFrame, HostInfo, Since, Subscribed};
pub use session::Session;
