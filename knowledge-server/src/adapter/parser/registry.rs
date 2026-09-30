//! 解析后端注册表。
//!
//! 分派规则与 aide 的 LSP 红线同构：**按扩展名分派**，
//! 上层不出现 `if is_docx()` 这类针对具体格式的分支。
//!
//! 同一扩展名注册了多个后端时，按注册顺序构成**回退链**：
//! 前一个失败自动落到后一个。这让「新しい后端先上、老后端兜底」
//! 成为配置问题而不是代码问题。

use std::path::Path;
use std::sync::Arc;

use crate::port::{DocumentParser, ParseError, ParseOutcome, ParserChain};

use super::{docx_lite, docx_to_md, html, markdown, pdf};

pub struct ParserRegistry {
    backends: Vec<Arc<dyn DocumentParser>>,
}

impl ParserRegistry {
    pub fn new(backends: Vec<Arc<dyn DocumentParser>>) -> Self {
        Self { backends }
    }

    /// 默认组合。**顺序即优先级**：前面的先试，失败才落到后面的。
    pub fn with_defaults() -> Self {
        Self::new(vec![
            Arc::new(markdown::MarkdownParser),
            // html 与 markdown 同属**文本形态**：原件原样入库，只是多一份
            // 剥了标记的可搜文本（domain::search_text）。扩展名与其余后端不重叠，
            // 位置只影响可读性。
            Arc::new(html::HtmlParser),
            // docx 双后端：docx-to-md 保真度高（直出 Markdown）但只有 0.1.0，
            // 排前面让它优先；失败则自动落到 docx-lite 兜底。
            // 想整体换后端，改这里一行即可，上层完全不感知。
            Arc::new(docx_to_md::DocxToMdParser),
            Arc::new(docx_lite::DocxLiteParser),
            Arc::new(pdf::PdfParser),
        ])
    }
}

impl ParserChain for ParserRegistry {
    fn supported_extensions(&self) -> Vec<String> {
        let mut exts: Vec<String> = self
            .backends
            .iter()
            .flat_map(|b| b.extensions().iter().map(|s| (*s).to_string()))
            .collect();
        exts.sort();
        exts.dedup();
        exts
    }

    fn backend_ids(&self) -> Vec<&'static str> {
        self.backends.iter().map(|b| b.id()).collect()
    }

    /// 按扩展名挑出候选后端，依次尝试，第一个成功的胜出。
    fn parse(&self, path: &Path) -> Result<ParseOutcome, ParseError> {
        let display = path.display().to_string();

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .ok_or_else(|| ParseError::Failed {
                path: display.clone(),
                reason: "无法识别文件扩展名".to_string(),
            })?;

        let mut last_err: Option<ParseError> = None;

        for backend in &self.backends {
            if !backend.extensions().contains(&ext.as_str()) {
                continue;
            }

            match backend.parse(path) {
                Ok(document) => {
                    tracing::info!(backend = backend.id(), ext = %ext, "解析成功");
                    return Ok(ParseOutcome {
                        document,
                        backend: backend.id(),
                    });
                }
                Err(e) => {
                    tracing::warn!(backend = backend.id(), ext = %ext, error = %e, "后端失败，尝试下一个");
                    last_err = Some(e);
                }
            }
        }

        Err(last_err.unwrap_or_else(|| ParseError::Failed {
            path: display,
            reason: format!("没有后端支持 .{ext} 格式"),
        }))
    }
}
