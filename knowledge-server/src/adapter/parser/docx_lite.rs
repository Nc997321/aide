//! docx → 纯文本适配器（docx-lite 后端）。
//!
//! 这是 docx 的**兜底**后端：只做文本提取，不转 Markdown，
//! 因此标题层级、列表缩进这些结构信息会丢失——这是它的代价，
//! 已经在 warnings 里如实上报，不做粉饰。
//!
//! 选它兜底的理由：依赖极少（只 zip + quick-xml）、流式解析、
//! 生产环境在用（V-Lawyer），周下载量 5000–20000。
//!
//! 将来若要保留层级：改用 `parse_document_from_path` 拿 paragraphs/lists
//! 再自行重建标题——那也只是改本文件，上层不动。

use std::path::Path;

use crate::port::{DocumentParser, ParseError, ParsedDocument};

use super::no_warnings;

pub struct DocxLiteParser;

impl DocumentParser for DocxLiteParser {
    fn id(&self) -> &'static str {
        "docx-lite"
    }

    fn extensions(&self) -> &[&'static str] {
        &["docx"]
    }

    fn parse(&self, path: &Path) -> Result<ParsedDocument, ParseError> {
        let display = path.display().to_string();

        let text = docx_lite::extract_text(path).map_err(|e| ParseError::Failed {
            path: display,
            reason: format!("提取文本失败: {e}"),
        })?;

        // 纯文本本身就是合法的 Markdown，可以直接存。
        // 但结构丢失是事实，写进 warnings 让用户看得见。
        Ok(ParsedDocument {
            title: None,
            markdown: text,
            warnings: vec!["docx-lite 后端只做文本提取，标题层级与列表结构已丢失".to_string()],
            // 这个后端不做图（文案在 Task 6 补「不提取图片」）
            assets: Vec::new(),
        })
    }
}

/// 供 registry 判断用：这个后端是否需要显式上报降级
#[allow(dead_code)]
pub(crate) const LOSES_STRUCTURE: bool = true;

/// 占位：保持与 markdown 模块一致的 helper 引用，避免未使用告警
#[allow(dead_code)]
pub(crate) fn _use_no_warnings() -> Vec<String> {
    no_warnings()
}
