//! 书签解析单测（独立测试文件，core_test.rs 风格）：
//! 覆盖两种格式的正常路径 + 形状容错 + 边界（空标题、无引号 href、实体顺序、中文大文件不 panic）。

use crate::browser::bookmarks::parse::{
    decode_import_text, parse_any, parse_chromium_json, parse_netscape_html, ParseError,
    ParsedBookmark,
};

fn bm(title: &str, url: &str) -> ParsedBookmark {
    ParsedBookmark {
        title: title.to_string(),
        url: url.to_string(),
    }
}

// ── Chromium Bookmarks JSON ──

#[test]
fn chromium_json_walks_roots_and_folders() {
    let raw = r#"{
      "checksum": "x",
      "roots": {
        "bookmark_bar": {
          "type": "folder",
          "name": "书签栏",
          "children": [
            { "type": "url", "name": "A", "url": "https://a.com/" },
            { "type": "folder", "name": "组", "children": [
                { "type": "url", "name": "B", "url": "https://b.com/" }
            ]}
          ]
        },
        "other": { "type": "folder", "name": "其他", "children": [
          { "type": "url", "name": "C", "url": "https://c.com/" }
        ]}
      },
      "version": 1
    }"#;
    assert_eq!(
        parse_chromium_json(raw).unwrap(),
        vec![
            bm("A", "https://a.com/"),
            bm("B", "https://b.com/"),
            bm("C", "https://c.com/")
        ]
    );
}

#[test]
fn chromium_json_tolerates_bare_array_and_missing_name() {
    // 裸数组形状 + name 缺失 → 标题回落 URL（不产出空标题条目）。
    let raw = r#"[{ "type": "url", "url": "https://a.com/" }]"#;
    assert_eq!(
        parse_chromium_json(raw).unwrap(),
        vec![bm("https://a.com/", "https://a.com/")]
    );
}

#[test]
fn chromium_json_rejects_malformed() {
    assert!(matches!(
        parse_chromium_json("{not json"),
        Err(ParseError::Json(_))
    ));
}

#[test]
fn chromium_json_keeps_dangerous_scheme_for_store_to_filter() {
    // 解析器不管合法性：`javascript:` 能过解析，由存储层过 url_guard 拦（守门只一处）。
    let raw = r#"{"roots":{"bookmark_bar":{"children":[
        {"type":"url","name":"坏","url":"javascript:alert(1)"}
    ]}}}"#;
    assert_eq!(
        parse_chromium_json(raw).unwrap(),
        vec![bm("坏", "javascript:alert(1)")]
    );
}

// ── Netscape HTML ──

#[test]
fn netscape_html_reads_anchors_and_skips_structure_tags() {
    let raw = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1699">文件夹</H3>
    <DL><p>
        <DT><A HREF="https://a.com/" ADD_DATE="1699">A 站</A>
        <DT><A HREF="https://b.com/">B 站</A>
    </DL><p>
</DL><p>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![bm("A 站", "https://a.com/"), bm("B 站", "https://b.com/")]
    );
}

#[test]
fn netscape_html_supports_unquoted_href_and_entities() {
    let raw = r#"<DT><A HREF=https://a.com/x?q=1&p=2>问答 &amp; 帮助</A>
<DT><A HREF='https://b.com/'>B &#39;引号&#39;</A>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![
            bm("问答 & 帮助", "https://a.com/x?q=1&p=2"),
            bm("B '引号'", "https://b.com/"),
        ]
    );
}

#[test]
fn netscape_html_skips_anchors_without_href_and_falls_back_title() {
    let raw = r#"<A NAME="x">锚点</A>
<A HREF="https://a.com/"></A>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![bm("https://a.com/", "https://a.com/")]
    );
}

#[test]
fn netscape_html_decodes_amp_last() {
    // `&amp;lt;` 必须解成 `&lt;` 而不是 `<`（顺序即正确性）。
    let raw = r#"<A HREF="https://a.com/">x &amp;lt; y</A>"#;
    assert_eq!(parse_netscape_html(raw)[0].title, "x &lt; y");
}

// ── 字节 → 文本 ──

#[test]
fn decode_utf16le_with_bom() {
    // 回归：记事本另存 HTML 默认给 UTF-16 LE + BOM——直接 read_to_string 会以
    // "stream did not contain valid UTF-8" 失败，导入当场挂。
    let text = "<A HREF=\"https://a.com/\">中文标题</A>";
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let decoded = decode_import_text(&bytes);
    assert_eq!(decoded, text);
    assert_eq!(parse_any(&decoded).unwrap()[0].title, "中文标题");
}

#[test]
fn decode_utf16be_with_bom() {
    let text = "书签";
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    assert_eq!(decode_import_text(&bytes), text);
}

#[test]
fn decode_plain_utf8_and_mangled_bytes_do_not_panic() {
    assert_eq!(decode_import_text("<A>".as_bytes()), "<A>");
    // 非法字节：替换字符兜住（不抛错、也不静默截断）——GBK 导出会落到这条路径（已知限制）。
    assert_eq!(decode_import_text(&[0xFF, 0x41]), "\u{FFFD}A");
}

// ── 嗅探入口 ──

#[test]
fn parse_any_sniffs_json_and_html() {
    assert_eq!(
        parse_any(r#"{"roots":{}}"#).unwrap(),
        Vec::<ParsedBookmark>::new()
    );
    assert_eq!(
        parse_any("<DT><A HREF=\"https://a.com/\">A</A>").unwrap(),
        vec![bm("A", "https://a.com/")]
    );
    assert_eq!(parse_any("hello world"), Err(ParseError::Unrecognized));
}

#[test]
fn parse_any_probes_first_4kb_by_char_not_by_byte() {
    // 回归：嗅探只看头 4KB。按**字符**取——按字节切片会在中文中间 panic（多字节边界）。
    let mut raw = "中文标题".repeat(700); // 约 2800 字符，落在探测窗内
    raw.push_str("<DT><A HREF=\"https://a.com/\">A</A>");
    assert_eq!(parse_any(&raw).unwrap(), vec![bm("A", "https://a.com/")]);

    // 超出探测窗 = 判不出来（设计行为：书签 HTML 的 `<a` 总在开头 DOCTYPE/TITLE 之后）。
    // 这里要保的是**不 panic**，不是"能认出来"。
    let mut far = "中".repeat(5000);
    far.push_str("<DT><A HREF=\"https://a.com/\">A</A>");
    assert_eq!(parse_any(&far), Err(ParseError::Unrecognized));
}
