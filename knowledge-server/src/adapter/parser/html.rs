//! html —— **文本产物**：原件原样入库。
//!
//! `ParsedDocument.markdown` 就是文件内容本身，不做任何转换：agent 读到的、
//! 人在编辑器里改的都是这份文本本体（剥过标签的 html 对 agent 是废的）。
//!
//! 可搜文本**不在这里产出**——它由 `domain::search_text::derive` 按 mime 一处算出，
//! 否则编辑保存的路径会漏算（spec Review Focus #4）。
//!
//! 范围：只有 html / htm。**csv / json 不在内**——Aide 全仓没有 csv 处理，
//! 文件类型词汇只有 markdown 与 html（spec §5.1）。

use std::path::Path;

use crate::port::{DocumentParser, ParseError, ParsedDocument};

pub struct HtmlParser;

impl DocumentParser for HtmlParser {
    fn id(&self) -> &'static str {
        "html"
    }

    fn extensions(&self) -> &[&'static str] {
        &["html", "htm"]
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParseError> {
        // read_to_string：非 UTF-8（GBK 之类）在这里就失败，绝不静默乱码。
        // 中文用户拿 GBK 的 html 是常事，宁可如实报「读取失败」也不给出乱码正文。
        let content = std::fs::read_to_string(path).map_err(|e| ParseError::Failed {
            path: path.display().to_string(),
            reason: format!("读取失败: {e}"),
        })?;

        Ok(ParsedDocument {
            // 产物类型由**服务端按扩展名**决定，绝不采信客户端给的 Content-Type
            mime: "text/html".to_string(),
            markdown: content,
            title: None, // 交给 ingest 用文件名兜底（domain/ingest.rs::parse_file）
            warnings: Vec::new(),
            assets: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::DocumentParser;
    use std::io::Write;

    fn write_fixture(name: &str, body: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("aide-kb-html-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body).unwrap();
        p
    }

    #[test]
    fn claims_both_html_extensions_and_nothing_else() {
        let exts = HtmlParser.extensions();
        assert!(exts.contains(&"html"));
        assert!(exts.contains(&"htm"));
        // 反向钉住：别顺手把 csv / json 加回来（spec §5.1 —— Aide 没有这些格式）
        assert!(!exts.contains(&"csv"));
        assert!(!exts.contains(&"json"));
    }

    #[test]
    fn mime_is_html_regardless_of_which_extension() {
        for name in ["a.html", "b.htm"] {
            let p = write_fixture(name, b"<p>x</p>");
            assert_eq!(HtmlParser.parse(&p).unwrap().mime, "text/html", "{name}");
        }
    }

    #[test]
    fn html_source_is_kept_verbatim() {
        // agent 读到的必须是原件——它可能要改它，剥过标签的 html 是废的。
        let src = "<p>你好</p>";
        let p = write_fixture("b.html", src.as_bytes());
        assert_eq!(HtmlParser.parse(&p).unwrap().markdown, src);
    }

    /// Review Focus #1：非 UTF-8（GBK）必须如实报错，不许静默乱码。
    #[test]
    fn non_utf8_file_fails_loudly() {
        // 0xC4 0xE3 是 GBK 的「你」，不是合法 UTF-8
        let p = write_fixture("gbk.html", &[0xC4, 0xE3, b',', b'1']);
        let err = HtmlParser.parse(&p).unwrap_err();
        assert!(format!("{err}").contains("读取失败"), "错误文案没写清原因: {err}");
    }

    #[test]
    fn title_is_left_to_the_ingest_fallback() {
        let p = write_fixture("季度复盘.html", b"<p>x</p>");
        assert_eq!(HtmlParser.parse(&p).unwrap().title, None);
    }
}
