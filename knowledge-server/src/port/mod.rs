//! 端口层：定义「要什么能力」，不定义「用什么实现」。
//!
//! 这一层**不允许出现任何第三方库类型**（sqlx / jieba / docx-* 都不行）。
//! 具体实现全部在 `crate::adapter::*`，上层只依赖这里的 trait。
//!
//! 这么做的原因见 CLAUDE.md「架构红线：可替换技术必须藏在端口后面」：
//! 换一个解析库、换一个分词算法，改动面应当收敛到 adapter 下的单个文件，
//! 而 `domain/` 与 `api/` 一行不动。

pub mod blob_store;
pub mod document_parser;
pub mod tokenizer;

pub use blob_store::{BlobError, BlobStore};
pub use document_parser::{DocumentParser, ParsedDocument, ParseError, ParseOutcome, ParserChain};
pub use tokenizer::Tokenizer;
