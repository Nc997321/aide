//! 适配器层：端口的具体实现。
//!
//! 这是整个 crate 里**唯一允许出现第三方库**的地方
//! （docx-lite / docx-to-md / pdf-extract / jieba-rs 都只在这里被引用）。
//! `port/` 定义要什么能力，这里回答用什么实现。
//!
//! 换技术时的预期改动面：本目录下的一个文件 + 注册表里的一行。

pub mod parser;
pub mod tokenizer;
