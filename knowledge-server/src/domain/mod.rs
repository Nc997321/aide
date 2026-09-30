//! 领域层：业务逻辑，只依赖 `port`，不依赖 `adapter`。
//!
//! 这里不允许出现 docx / jieba / pdf 等任何具体库的名字——
//! 需要那些能力时通过 `port` 上的 trait 拿，由装配处注入实现。

pub mod deletion;
pub mod ingest;
pub mod locking;
pub mod permission;
pub mod preview_token;
pub mod search;
pub mod search_text;
pub mod session;
pub mod tree;
pub mod versioning;
