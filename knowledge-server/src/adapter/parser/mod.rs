//! 文档解析适配器：把一个 `DocumentParser` 端口落到具体的库上。
//!
//! 新增一个后端 = 在这里加一个文件 + 在 `registry` 里注册一行。
//! 上层（`domain::ingest`、`api::ingest`）不需要知道它的存在。

pub mod docx_lite;
pub mod docx_to_md;
pub mod markdown;
pub mod pdf;
pub mod registry;

pub use registry::ParserRegistry;

use crate::port::ParsedDocument;

/// 从 Markdown 正文里取第一个一级标题作为文档标题。
/// 找不到就返回 None，由调用方决定兜底（通常用文件名）。
pub(crate) fn first_heading(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        let line = line.trim_end();
        let rest = line.strip_prefix("# ")?;
        let title = rest.trim();
        (!title.is_empty()).then(|| title.to_string())
    })
}

/// 空的 warnings vec，避免每个实现都写一遍。
pub(crate) fn no_warnings() -> Vec<String> {
    Vec::new()
}

#[allow(dead_code)]
pub(crate) fn with_title(doc: ParsedDocument) -> ParsedDocument {
    doc
}
