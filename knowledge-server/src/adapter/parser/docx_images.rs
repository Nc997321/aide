//! 从 Markdown 里抽出 `data:` URL 形式的图片。
//!
//! 为什么不去用 docx-to-md 的 `ImageHandlingMode::Save`：
//! 它的 `image_output_path()` 是**私有函数**，文件名派生自 `resource.part_path`
//! 并且会改扩展名（jpeg 统一成 .jpg，见 docx-to-md 0.1.0 的 render.rs:495-510）。
//! 想按文件名反查图片就得复刻那段私有逻辑 —— crate 一改命名规则，我们就静默丢图。
//!
//! 直接从 data URL 抽：alt / MIME / 字节全在 URL 里，**位置天然正确**，
//! 不依赖任何私有 API、不需要临时目录、不需要文件系统。
//!
//! 用默认的 `InMarkdown` 模式即可（docx-to-md 的 `ParserConfig::default()`），
//! 它产出的是 `data:{mime};base64,{payload}`（render.rs:427）。

use crate::port::{placeholder, ParsedAsset};

pub struct ExtractedImages {
    pub markdown: String,
    pub assets: Vec<ParsedAsset>,
    pub warnings: Vec<String>,
}

/// 扫描并替换。下标按图片在正文中出现的顺序分配。
pub fn extract_data_url_images(markdown: &str) -> ExtractedImages {
    let mut out = String::with_capacity(markdown.len());
    let mut assets = Vec::new();
    let mut warnings = Vec::new();
    let mut cursor = 0usize;

    while let Some(img_start) = find_from(markdown, cursor, "![") {
        let alt_start = img_start + 2;

        // alt 与 URL 的分界是 `](`
        let Some(alt_end) = find_from(markdown, alt_start, "](") else {
            break;
        };
        let url_start = alt_end + 2;

        if !markdown[url_start..].starts_with("data:") {
            // 外链图片或普通链接：原样保留，从 URL 之后继续找
            out.push_str(&markdown[cursor..url_start]);
            cursor = url_start;
            continue;
        }

        // base64 与 MIME 里都不可能出现 `)`，所以第一个 `)` 就是边界
        let Some(url_end) = find_from(markdown, url_start, ")") else {
            break;
        };

        let alt = &markdown[alt_start..alt_end];
        out.push_str(&markdown[cursor..img_start]);

        match decode_data_url(&markdown[url_start..url_end]) {
            Ok((mime, bytes)) => {
                let idx = assets.len();
                out.push_str("![");
                out.push_str(alt);
                out.push_str("](");
                out.push_str(&placeholder(idx));
                out.push(')');
                assets.push(ParsedAsset { mime, bytes });
            }
            Err(reason) => {
                // 不整体失败：退化成占位文本并如实上报（与 warnings 的既有语义一致）
                out.push_str("[图片无法提取]");
                warnings.push(format!("1 张图片无法提取：{reason}"));
            }
        }

        cursor = url_end + 1;
    }

    out.push_str(&markdown[cursor..]);

    ExtractedImages {
        markdown: out,
        assets,
        warnings,
    }
}

/// 从 `from` 起找 `needle`。`get(..)` 保证落在字符边界上，越界返回 None。
fn find_from(haystack: &str, from: usize, needle: &str) -> Option<usize> {
    haystack.get(from..)?.find(needle).map(|rel| from + rel)
}

/// 拆 `data:<mime>;base64,<payload>`。只认 base64 形态，只收 `image/*`。
fn decode_data_url(url: &str) -> Result<(String, Vec<u8>), String> {
    use base64::Engine;

    let body = url.strip_prefix("data:").ok_or("不是 data: URL")?;
    let (head, payload) = body.split_once(";base64,").ok_or("不是 base64 形态")?;

    if head.is_empty() {
        return Err("缺少 MIME 类型".to_string());
    }
    if !head.starts_with("image/") {
        // data:text/html 之类绝不落盘：本服务只按 Content-Type 发字节，
        // 但把非图片内容当资源存进库是没有理由的面
        return Err(format!("非图片类型 {head}"));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("base64 解码失败：{e}"))?;

    Ok((head.to_string(), bytes))
}

#[cfg(test)]
mod tests {
    use super::extract_data_url_images;

    /// 1x1 透明 PNG 的 base64（最短合法样本）。
    const PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    /// PNG 的 8 字节文件签名。用它断言「真的解码出了 PNG」而不是只看长度。
    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

    #[test]
    fn extracts_single_image() {
        let md = format!("前言\n\n![示意图](data:image/png;base64,{PNG_B64})\n\n后记");

        let out = extract_data_url_images(&md);

        assert_eq!(out.assets.len(), 1);
        assert_eq!(out.assets[0].mime, "image/png");
        assert!(
            out.assets[0].bytes.starts_with(PNG_MAGIC),
            "解码结果必须是 PNG 字节，实际前 8 字节：{:?}",
            &out.assets[0].bytes[..out.assets[0].bytes.len().min(8)]
        );
        assert!(
            out.markdown.contains("![示意图]({{asset:0}})"),
            "实际：{}",
            out.markdown
        );
        assert!(!out.markdown.contains("base64"), "不得残留 base64");
        assert!(out.markdown.starts_with("前言"), "图片前的正文必须原样保留");
        assert!(out.markdown.ends_with("后记"), "图片后的正文必须原样保留");
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn extracts_multiple_images_in_order() {
        let md =
            format!("![一](data:image/png;base64,{PNG_B64})\n![二](data:image/png;base64,{PNG_B64})");

        let out = extract_data_url_images(&md);

        assert_eq!(out.assets.len(), 2);
        assert!(
            out.markdown.find("{{asset:0}}").unwrap() < out.markdown.find("{{asset:1}}").unwrap(),
            "下标必须按出现顺序"
        );
        assert!(out.markdown.contains("![一]({{asset:0}})"));
        assert!(out.markdown.contains("![二]({{asset:1}})"));
        assert!(out.warnings.is_empty());
    }

    /// 带值路径优先：外链图片、普通链接、裸 data: 文本都不能被动。
    #[test]
    fn leaves_non_data_urls_untouched() {
        let md = "![外链](https://example.com/a.png)\n[普通链接](https://example.com)\n\
                  文本里提到 data:image/png;base64,AAAA 但不是图片语法";

        let out = extract_data_url_images(md);

        assert_eq!(out.assets.len(), 0);
        assert_eq!(out.markdown, md, "无 data URL 图片时输出必须逐字节等于输入");
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn warns_and_degrades_on_bad_base64() {
        let md = "![坏图](data:image/png;base64,!!!not-base64!!!)";

        let out = extract_data_url_images(md);

        assert_eq!(out.assets.len(), 0);
        assert!(
            out.markdown.contains("[图片无法提取]"),
            "实际：{}",
            out.markdown
        );
        assert!(!out.markdown.contains("base64"), "坏图也不能把 base64 留在正文里");
        assert_eq!(out.warnings.len(), 1);
    }

    #[test]
    fn rejects_non_image_data_url() {
        let md = "![伪装](data:text/html;base64,PHNjcmlwdD4=)";

        let out = extract_data_url_images(md);

        assert_eq!(out.assets.len(), 0, "非 image/* 一律不抽");
        assert!(out.markdown.contains("[图片无法提取]"));
        assert_eq!(out.warnings.len(), 1);
    }

    #[test]
    fn handles_empty_and_image_free_input() {
        assert_eq!(extract_data_url_images("").markdown, "");
        assert_eq!(extract_data_url_images("纯文本").markdown, "纯文本");
        assert!(extract_data_url_images("").assets.is_empty());
    }
}
