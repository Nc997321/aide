//! docx → Markdown 适配器（docx-to-md 后端）。
//!
//! 这是 docx 的**首选**后端：直接产出 Markdown，保留标题层级、列表、
//! 表格、链接，正好是知识库要的形态。相比之下 POI 只给对象树，
//! 转 Markdown 还得自己写。
//!
//! 但它是 0.1.0（2026-07 首发），成熟度未经长期验证——所以它排在
//! 回退链第一位而不是唯一一位：失败时由 `registry` 自动落到 docx-lite。

use std::path::Path;

use docx_to_md::{DocumentContainer, ParserConfig};

use crate::port::{DocumentParser, ParseError, ParsedDocument};

use super::{first_heading, no_warnings};

pub struct DocxToMdParser;

impl DocumentParser for DocxToMdParser {
    fn id(&self) -> &'static str {
        "docx-to-md"
    }

    fn extensions(&self) -> &[&'static str] {
        &["docx"]
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParseError> {
        let display = path.display().to_string();

        let package =
            DocumentContainer::open(path, ParserConfig::default()).map_err(|e| {
                ParseError::Failed {
                    path: display.clone(),
                    reason: format!("打开失败: {e}"),
                }
            })?;

        let markdown = package
            .convert_to_md()
            .map_err(|e| ParseError::Failed {
                path: display,
                reason: format!("转换失败: {e}"),
            })?;

        Ok(ParsedDocument {
            title: first_heading(&markdown),
            markdown,
            warnings: no_warnings(),
            // 抽图在下一个任务接（Task 5）：本轮先让端口变更编译通过
            assets: Vec::new(),
        })
    }
}
