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
//! **目录（v2 起保留）**：两种格式都必须给出**同形**结果——`folders` 是从外到内的路径分段，
//! 空数组 = 根级。跨格式同形是契约：换个浏览器导出，层级不该跟着变形状。
//!
//! 两个格式都有的一个陷阱：**「书签栏」本身是工具栏容器、不是文件夹**（Netscape 的
//! `PERSONAL_TOOLBAR_FOLDER="true"` / Chromium 的 `roots.bookmark_bar`）。那一层要丢掉、子节点提升
//! 到根层，否则导入进来每条都白挂一层「收藏夹栏」。

use regex::Regex;

/// 解析出的一条候选书签：还没发 id/时间戳，也还没过 `url_guard`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBookmark {
    pub title: String,
    pub url: String,
    /// 目录路径，从外到内（如 `["工作", "漳蒲"]`）；空 = 根级。
    /// **分段里不会有空串**——空名目录当透明层（见两处 `Transparent` 判据）。
    pub folders: Vec<String>,
    /// `ICON="data:…"` 的**原始字符串**（含 `data:` 前缀），没有则 `None`。
    ///
    /// 这里**不校验**——跟 url 一样，"文件里有什么"归解析器、"合不合法"归存储层（唯一守门处
    /// 在 `favicons::decode_data_uri`）。Chromium 系导出会带它，Chrome 旧版导出不带。
    pub icon: Option<String>,
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
    let mut folders: Vec<String> = Vec::new();
    match &v {
        serde_json::Value::Object(map) => {
            // `roots` 是**命名容器**（`{"bookmark_bar": <folder>, "other": <folder>, ...}`）——
            // 它自己不是节点、也没有 `children`，所以要遍历它的值逐棵走。少了这一步，真机上
            // 一条都解析不出来（节点在容器下面一层）。
            match map.get("roots").and_then(|r| r.as_object()) {
                Some(roots) => {
                    for (key, node) in roots {
                        // 只有 `bookmark_bar` 是"书签栏本身"要丢层；`other`（其他书签）/`synced`/
                        // `mobile` 是真的文件夹容器，名字保留成一层。
                        if key == "bookmark_bar" {
                            walk_json_children(node, &mut folders, &mut out);
                        } else {
                            walk_json(node, &mut folders, &mut out);
                        }
                    }
                }
                None => walk_json(&v, &mut folders, &mut out),
            }
        }
        other => walk_json(other, &mut folders, &mut out),
    }
    Ok(out)
}

/// 递归走节点：`type=="url"` 收下，有名字的 `folder` 入栈一层，`children` 继续下钻。
fn walk_json(
    node: &serde_json::Value,
    folders: &mut Vec<String>,
    out: &mut Vec<ParsedBookmark>,
) {
    match node {
        serde_json::Value::Array(items) => {
            for item in items {
                walk_json(item, folders, out);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(bookmark) = url_node(map, folders) {
                out.push(bookmark);
            }
            let pushed = push_folder(map, folders);
            if let Some(children) = map.get("children") {
                walk_json(children, folders, out);
            }
            if pushed {
                folders.pop();
            }
        }
        _ => {}
    }
}

/// 只走节点的 `children`（给「书签栏」容器用：它自己那一层要丢、子节点提升到根层）。
fn walk_json_children(
    node: &serde_json::Value,
    folders: &mut Vec<String>,
    out: &mut Vec<ParsedBookmark>,
) {
    match node {
        serde_json::Value::Array(items) => {
            for item in items {
                walk_json(item, folders, out);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(children) = map.get("children") {
                walk_json(children, folders, out);
            }
        }
        _ => {}
    }
}

/// 节点若是一条 URL 书签就产出候选（路径 = 当前栈）。
fn url_node(
    map: &serde_json::Map<String, serde_json::Value>,
    folders: &[String],
) -> Option<ParsedBookmark> {
    if map.get("type").and_then(|t| t.as_str()) != Some("url") {
        return None;
    }
    let url = map.get("url").and_then(|u| u.as_str())?;
    let title = map
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .trim();
    Some(ParsedBookmark {
        title: if title.is_empty() {
            url.to_string()
        } else {
            title.to_string()
        },
        url: url.to_string(),
        folders: folders.to_vec(),
        // `Bookmarks` JSON **不带图标**：Chromium 把图标存在隔壁的 `Favicons` 库里（按 URL 索引），
        // 跟书签文件是两回事。所以 JSON 导入拿不到图标——这是格式事实，不是我们漏读。
        icon: None,
    })
}

/// 有名字的 `folder` 入栈，返回**是否真的入栈**（调用方据此配套出栈，别弹掉别人的层）。
/// 匿名/空名 folder 当透明层：它的子节点留在父层，不产出 `[""]` 这种空路径段。
fn push_folder(
    map: &serde_json::Map<String, serde_json::Value>,
    folders: &mut Vec<String>,
) -> bool {
    if map.get("type").and_then(|t| t.as_str()) != Some("folder") {
        return false;
    }
    let name = map
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or_default()
        .trim();
    if name.is_empty() {
        return false;
    }
    folders.push(name.to_string());
    true
}

// ── Netscape 书签 HTML ────────────────────────────────────────────────────

/// 目录栈的一格。
///
/// `Transparent` 存在的理由：工具栏根与空名目录**不贡献路径分段，但必须占栈的一格**——否则它
/// 那个 `</DL>` 会把外层目录提前弹掉，后面所有条目集体错层。
#[derive(Debug, Clone)]
enum Level {
    Folder(String),
    Transparent,
}

/// Netscape 书签 HTML。**按 `<DL>` 嵌套走栈**提取目录路径。
///
/// v1 只扫 `<A HREF>`（目录信息只存在于它与 `<DL>` 的相对位置上，那样必然丢掉）。这里改成一趟
/// 扫完、四种记号按文档顺序命中：开容器 / 闭容器 / 目录名 / 书签。
/// href 支持双引号/单引号/无引号三种写法（老导出器会有无引号）。
pub fn parse_netscape_html(raw: &str) -> Vec<ParsedBookmark> {
    // 各捕获组：1=`<DL>` 开、2=`</DL>` 闭、3=`<H3>` 属性、4=目录名、5=`<A>` 属性串、6=标题。
    // **`<A>` 的整段属性一起抓**，href / icon 各自再去属性串里取——属性顺序不统一，把两个属性写进
    // 同一条正则就只能认一种顺序。
    // 属性名大小写与空白都宽松；名字/标题用非贪婪 + dot-all（里面可能有换行）。
    let re = Regex::new(r#"(?is)(<dl[^>]*>)|(</dl\s*>)|<h3([^>]*)>(.*?)</h3\s*>|<a\s([^>]*)>(.*?)</a\s*>"#)
        .expect("书签 HTML 正则写死在源码里，编译期常量");

    let mut stack: Vec<Level> = Vec::new();
    // 目录名先于它的容器出现（`<H3>工作</H3>` 在前、`<DL>` 在后）——名字先挂这儿，等 `<DL>` 开时入栈。
    let mut pending: Option<Level> = None;
    let mut out = Vec::new();

    for cap in re.captures_iter(raw) {
        if cap.get(1).is_some() {
            if let Some(level) = pending.take() {
                stack.push(level);
            }
        } else if cap.get(2).is_some() {
            // 多余的 `</DL>` 只会把栈弹到空，不 panic、不产生幽灵目录。
            stack.pop();
        } else if let Some(attrs) = cap.get(3) {
            let name = decode_entities(cap.get(4).map_or("", |m| m.as_str()))
                .trim()
                .to_string();
            pending = Some(level_of(attrs.as_str(), name));
        } else {
            // 剩下的只有 `<A>` 一支：5 = 属性串、6 = 标题。
            let attrs = cap.get(5).map_or("", |m| m.as_str());
            let text = cap.get(6).map_or("", |m| m.as_str());
            if let Some(bookmark) = anchor(attrs, text, &stack) {
                out.push(bookmark);
            }
        }
    }
    out
}

/// `<H3>` 属性 + 名字 → 栈元素。工具栏根与空名目录都是透明层（见 [`Level`]）。
fn level_of(attrs: &str, name: String) -> Level {
    // 判据用属性**名**：值 `"true"` 只是常规形态，真机导出里引号/大小写都不保证。
    if attrs.to_ascii_lowercase().contains("personal_toolbar_folder") || name.is_empty() {
        Level::Transparent
    } else {
        Level::Folder(name)
    }
}

/// `<A ` 的属性串 + 标题 → 候选书签（路径 = 当前栈，透明层滤掉）。没有 href / href 为空 → `None`。
fn anchor(attrs: &str, text: &str, stack: &[Level]) -> Option<ParsedBookmark> {
    let url = href_of(attrs)?;
    if url.is_empty() {
        return None;
    }
    let title = decode_entities(text).trim().to_string();
    let folders = stack
        .iter()
        .filter_map(|level| match level {
            Level::Folder(name) => Some(name.clone()),
            Level::Transparent => None,
        })
        .collect();
    Some(ParsedBookmark {
        title: if title.is_empty() {
            url.clone()
        } else {
            title
        },
        url,
        folders,
        // 空串当没有：别把空值送进缓存层让它去校验。
        icon: icon_of(attrs).filter(|s| !s.is_empty()),
    })
}

/// 从 `<A>` 的属性串里取 `href`（双引号/单引号/裸写三种写法，老导出器会有无引号）。
fn href_of(attrs: &str) -> Option<String> {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?i)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).expect("属性正则写死")
    });
    let cap = re.captures(attrs)?;
    let raw = cap.get(1).or_else(|| cap.get(2)).or_else(|| cap.get(3))?;
    Some(raw.as_str().trim().to_string())
}

/// 从 `<A>` 的属性串里取 `ICON`（站点图标的 data URI）。
///
/// `\b` 不是装饰：`LAST_ICON="…"` 里的 `ICON` 前面是 `_`（词字符），没有词边界，不会误命中；
/// `ICON_URI="…"` 后面接的是 `_` 而不是 `=`，也过不了 `\s*=`。
fn icon_of(attrs: &str) -> Option<String> {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?i)\bicon\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).expect("属性正则写死")
    });
    let cap = re.captures(attrs)?;
    let raw = cap.get(1).or_else(|| cap.get(2)).or_else(|| cap.get(3))?;
    Some(raw.as_str().trim().to_string())
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
