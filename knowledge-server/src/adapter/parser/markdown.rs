//! Markdown / 纯文本直通适配器。
//!
//! 知识库的一等格式就是 Markdown，所以这里不做转换，只负责读取与抽标题。

use std::path::Path;

use crate::port::{DocumentParser, ParseError, ParsedDocument};

use super::{first_heading, no_warnings};

pub struct MarkdownParser;

impl DocumentParser for MarkdownParser {
    fn id(&self) -> &'static str {
        "markdown"
    }

    fn extensions(&self) -> &[&'static str] {
        &["md", "markdown", "txt"]
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParseError> {
        let content = std::fs::read_to_string(path).map_err(|e| ParseError::Failed {
            path: path.display().to_string(),
            reason: format!("读取失败: {e}"),
        })?;

        Ok(ParsedDocument {
            title: first_heading(&content),
            markdown: content,
            warnings: no_warnings(),
        })
    }
}
