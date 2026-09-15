//! 书签文件解析：两种通用互换格式，**纯函数**（无 IO、无时钟、无全局状态，脱离 webview 可单测）。
//!
//! - [`parse_chromium_json`]：Chromium 系 `Bookmarks` JSON（Edge/Chrome 的 profile 文件形状，
//!   也是它们"导出"之外的机器可读形态）。
//! - [`parse_netscape_html`]：`<!DOCTYPE NETSCAPE-Bookmark-file-1>` HTML——**所有浏览器「导出书签
//!   为 HTML」用的就是这个**，是事实上的互换标准。
//!
//! 解析器只负责"文件里有什么"，**不管合不合法**：`javascript:` / `chrome://` 这类危险 scheme 的过滤
//! 交给存储层过一遍 `url_guard`（唯一守门处，不在两个解析器里各写一份）。
//!
//! 目录结构 v1 **拍平**（Chromium JSON 的 folder 树 / Netscape 的 `<H3>` 都不保留），
//! 去重按 URL——需要目录分组时再加字段，别现在猜。

use regex::Regex;

/// 解析出的一条候选书签：还没发 id/时间戳，也还没过 `url_guard`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBookmark {
    pub title: String,
    pub url: String,
}

/// 解析失败（目前只有"JSON 畸形"一种：HTML 格式宽松，解析不出条目就是空列表）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    Json(String),
    /// 两种格式的嗅探都不认（既不是 JSON 也不像书签 HTML）。
    Unrecognized,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Json(detail) => write!(f, "bookmarks json parse failed: {detail}"),
            ParseError::Unrecognized => {
                write!(
                    f,
                    "unrecognized bookmark file (expect Chromium JSON or Netscape HTML)"
                )
            }
        }
    }
}

impl std::error::Error for ParseError {}

// ── Chromium Bookmarks JSON ───────────────────────────────────────────────

/// Chromium 系 `Bookmarks` JSON。
///
/// 容忍三种形状（都是真实见过的）：`{"roots": {...}}`（profile 文件）、裸节点
/// `{"type":"url",...}`、裸数组。递归收集 `type == "url"` 的节点；`name` 缺失时标题回落到 URL。
pub fn parse_chromium_json(raw: &str) -> Result<Vec<ParsedBookmark>, ParseError> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| ParseError::Json(e.to_string()))?;
    let mut out = Vec::new();
    match &v {
        serde_json::Value::Object(map) => {
            // `roots` 是**命名容器**（`{"bookmark_bar": <folder>, "other": <folder>, ...}`）——
            // 它自己不是节点、也没有 `children`，所以要遍历它的值逐棵走。少了这一步，真机上
            // 一条都解析不出来（节点在容器下面一层）。
            match map.get("roots").and_then(|r| r.as_object()) {
                Some(roots) => {
                    for node in roots.values() {
                        walk_json(node, &mut out);
                    }
                }
                None => walk_json(&v, &mut out),
            }
        }
        other => walk_json(other, &mut out),
    }
    Ok(out)
}

/// 递归走节点：`type=="url"` 收下，`children` 继续下钻。
fn walk_json(node: &serde_json::Value, out: &mut Vec<ParsedBookmark>) {
    match node {
        serde_json::Value::Array(items) => {
            for item in items {
                walk_json(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            let is_url = map.get("type").and_then(|t| t.as_str()) == Some("url");
            if is_url {
                if let Some(url) = map.get("url").and_then(|u| u.as_str()) {
                    let title = map
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or_default()
                        .to_string();
                    out.push(ParsedBookmark {
                        title: if title.trim().is_empty() {
                            url.to_string()
                        } else {
                            title
                        },
                        url: url.to_string(),
                    });
                }
            }
            if let Some(children) = map.get("children") {
                walk_json(children, out);
            }
        }
        _ => {}
    }
}

// ── Netscape 书签 HTML ────────────────────────────────────────────────────

/// Netscape 书签 HTML。**宽松解析**：只认 `<A HREF="…" …>标题</A>`，其余标签（`<DT>`/`<H3>`/`<DL>`）
/// 一律忽略——目录不保留（见模块头）。href 支持双引号/单引号/无引号三种写法（老导出器会有无引号）。
pub fn parse_netscape_html(raw: &str) -> Vec<ParsedBookmark> {
    // 属性名大小写与空白都宽松；标题用非贪婪 + dot-all（标题里可能有换行）。
    let re = Regex::new(
        r#"(?is)<a\s[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>(.*?)</a\s*>"#,
    )
    .expect("书签 HTML 正则写死在源码里，编译期常量");
    let mut out = Vec::new();
    for cap in re.captures_iter(raw) {
        let url = cap
            .get(1)
            .or_else(|| cap.get(2))
            .or_else(|| cap.get(3))
            .map(|m| m.as_str().trim())
            .unwrap_or_default();
        if url.is_empty() {
            continue;
        }
        let title = decode_entities(cap.get(4).map(|m| m.as_str()).unwrap_or_default())
            .trim()
            .to_string();
        out.push(ParsedBookmark {
            title: if title.is_empty() {
                url.to_string()
            } else {
                title
            },
            url: url.to_string(),
        });
    }
    out
}

/// 常见 HTML 实体解码（够用即可，不做完整实体表）。
///
/// `&amp;` **最后**解——否则 `&amp;lt;` 会被解成 `<` 而不是 `&lt;`（顺序即正确性）。
fn decode_entities(s: &str) -> String {
    static NUMERIC: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let numeric =
        NUMERIC.get_or_init(|| Regex::new(r"&#(x?[0-9A-Fa-f]+);").expect("数字实体正则写死"));
    let decoded = numeric
        .replace_all(s, |cap: &regex::Captures| {
            let body = &cap[1];
            let code = if let Some(hex) = body.strip_prefix(['x', 'X']) {
                u32::from_str_radix(hex, 16).ok()
            } else {
                body.parse::<u32>().ok()
            };
            code.and_then(char::from_u32)
                .map(|c| c.to_string())
                .unwrap_or_else(|| cap[0].to_string())
        })
        .to_string();
    decoded
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

// ── 字节 → 文本（导入入口用） ──────────────────────────────────────────────

/// 书签文件的字节 → 文本。
///
/// 浏览器自己导出的 HTML 几乎都是 UTF-8，但 Windows 上真实见过 **UTF-16**（记事本另存为 HTML 的
/// 默认编码是 UTF-16 LE），直接 `read_to_string` 会以 "stream did not contain valid UTF-8" 失败。
/// 判据用 BOM：UTF-16LE/BE 按 BOM 解，其余按 UTF-8 解（非法字节用替换字符兜住，不抛错也不静默截断）。
///
/// **已知限制**：GBK/GB18030 导出（少数老工具）会显示成替换字符；根治要引 `encoding_rs`，
/// 现在不做——真遇到了再说，而不是提前背一个依赖。
pub fn decode_import_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16(&bytes[2..], false);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 按指定端序把字节对拼成 `u16` 再转字符串（奇数尾字节忽略——截断的最后一字节没有意义）。
fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

// ── 嗅探入口 ──────────────────────────────────────────────────────────────

/// 按内容嗅探挑解析器（导入入口用：用户选的文件可能叫任何名字）。
///
/// 判据用内容不用扩展名——`.html`/`.json` 都是用户自己导出的，改名很常见。
pub fn parse_any(raw: &str) -> Result<Vec<ParsedBookmark>, ParseError> {
    let head = raw.trim_start();
    if head.starts_with('{') || head.starts_with('[') {
        return parse_chromium_json(raw);
    }
    // 大小写不敏感地找书签 HTML 的标志串。只看头 4KB（够覆盖 DOCTYPE/TITLE 区）。
    // 按字符取而不是字节切片——中文标题下按字节切会落在字符中间 panic。
    let probe: String = head
        .chars()
        .take(4096)
        .collect::<String>()
        .to_ascii_lowercase();
    if probe.contains("<a ") && probe.contains("href") {
        return Ok(parse_netscape_html(raw));
    }
    Err(ParseError::Unrecognized)
}
