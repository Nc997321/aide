//! PDF → 文本适配器（pdf-extract 后端）。
//!
//! PDF 没有可靠的通用「转 Markdown」路径：版式复杂的 PDF 连段落顺序都可能错。
//! 所以这里老老实实只做文本提取，并把不确定性写进 warnings。
//!
//! 若将来需要更强的 PDF 能力（表格还原、版面分析），换后端只改本文件。

use std::path::Path;

use crate::port::{DocumentParser, ParseError, ParsedDocument};

use super::no_warnings;

pub struct PdfParser;

impl DocumentParser for PdfParser {
    fn id(&self) -> &'static str {
        "pdf-extract"
    }

    fn extensions(&self) -> &[&'static str] {
        &["pdf"]
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParseError> {
        let display = path.display().to_string();

        let text = pdf_extract::extract_text(path).map_err(|e| ParseError::Failed {
            path: display,
            reason: format!("提取文本失败: {e}"),
        })?;

        let warnings = if text.trim().is_empty() {
            vec!["未能提取到文本，可能是扫描件（图片型 PDF），需要 OCR".to_string()]
        } else {
            no_warnings()
        };

        Ok(ParsedDocument {
            // 产物是抽取出来的文本，**不是** pdf 本身（见 port::ParsedDocument）
            mime: "text/markdown".to_string(),
            title: None,
            markdown: text,
            warnings,
            assets: Vec::new(),
        })
    }
}
