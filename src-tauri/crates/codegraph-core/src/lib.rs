//! CodeGraph shared kernel.
//!
//! 按优化项二（CodeGraph 进程隔离）拆出的纯数据层，被两侧共同依赖：
//! - `aide`（主进程）：lsp 协议层引用 `types::QueryResult`、settings 层引用
//!   `RuntimeCodeGraphEmbedderConfig`、proxy 层引用 `protocol` 消息形状；
//! - `codegraph-runner`（aide-codegraph.exe）：全部索引/查询逻辑 + 同一套
//!   types / config / protocol。
//!
//! **红线**：本 crate 只准依赖 serde——它是两侧的「签名合同」，任何重依赖
//! （ort / tree-sitter / qdrant-edge）进来都会重新污染主进程二进制。

pub mod config;
pub mod ignore_dirs;
pub mod protocol;
pub mod types;

pub use config::{
    default_score_threshold, effective_score_threshold, RuntimeCodeGraphEmbedderConfig,
};
