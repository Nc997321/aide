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

use super::first_heading;

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

        // 把内嵌数据 URL 图片抽成附件。docx-to-md 默认的 ImageHandlingMode::InMarkdown
        // 会把图片写成 `![](data:image/jpeg;base64,...)` —— 抽出来之后正文里只剩
        // 占位符，字节不再进倒排索引（见 design spec §1.1 第三环）。
        let extracted = super::docx_images::extract_data_url_images(&markdown);

        Ok(ParsedDocument {
            // 产物是解析出来的 markdown，**不是** docx 本身（见 port::ParsedDocument）
            mime: "text/markdown".to_string(),
            title: first_heading(&extracted.markdown),
            markdown: extracted.markdown,
            warnings: extracted.warnings,
            assets: extracted.assets,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::DocxToMdParser;
    use crate::port::DocumentParser;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name)
    }

    /// 真实文档端到端：docx-to-md 把内嵌图写成 `data:` URL，再由
    /// `extract_data_url_images` 抽成附件。
    ///
    /// 这条链路是 v1 的核心，而它建立在**一个前提假设**上 ——
    /// 「docx-to-md 默认产出 `![](data:...;base64,...)`」。合成输入测不出这个假设，
    /// 只有拿真 docx 跑才行（fixture 由一份真实说明书改造：图片替换成 1x1 PNG，
    /// 保留完整的 OOXML 结构与 16 个图片引用）。
    #[test]
    fn extracts_images_from_real_docx() {
        let parsed = DocxToMdParser
            .parse(&fixture("with_image.docx"))
            .expect("解析 fixture 失败");

        assert!(
            !parsed.assets.is_empty(),
            "这份 fixture 含 16 张内嵌图，必须抽出来"
        );
        assert!(
            !parsed.markdown.contains("base64"),
            "正文里不得残留 base64（否则整个倒排索引被污染）"
        );
        assert_eq!(
            parsed.markdown.matches("{{asset:").count(),
            parsed.assets.len(),
            "占位符个数必须与 assets 一一对应"
        );
        assert!(
            parsed.assets.iter().all(|a| a.mime.starts_with("image/")),
            "只该抽出 image/*"
        );
        assert!(
            parsed.assets.iter().all(|a| !a.bytes.is_empty()),
            "抽出的图不能是空字节"
        );
    }

    /// 无图文档不该被这条链路影响 —— 带值路径的反面同样要钉。
    #[test]
    fn text_only_docx_yields_no_assets() {
        let parsed = DocxToMdParser
            .parse(&fixture("plain.docx"))
            .expect("解析 fixture 失败");

        assert!(parsed.assets.is_empty());
        assert!(!parsed.markdown.contains("{{asset:"));
    }
}
