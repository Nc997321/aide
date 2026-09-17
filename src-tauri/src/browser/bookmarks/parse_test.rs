//! 书签解析单测（独立测试文件，core_test.rs 风格）：
//! 覆盖两种格式的正常路径 + 形状容错 + 边界（空标题、无引号 href、实体顺序、中文大文件不 panic），
//! 以及**目录路径提取**（两种格式必须给出同形结果——那是"换了导出器也不丢层级"的契约）。

use crate::browser::bookmarks::parse::{
    decode_import_text, parse_any, parse_chromium_json, parse_netscape_html, ParseError,
    ParsedBookmark,
};

/// 根级条目（无目录、无图标）。
fn bm(title: &str, url: &str) -> ParsedBookmark {
    ParsedBookmark {
        title: title.to_string(),
        url: url.to_string(),
        folders: Vec::new(),
        icon: None,
    }
}

/// 指定目录路径下的条目（路径按从外到内给）。
fn in_dir(title: &str, url: &str, folders: &[&str]) -> ParsedBookmark {
    ParsedBookmark {
        title: title.to_string(),
        url: url.to_string(),
        folders: folders.iter().map(|s| s.to_string()).collect(),
        icon: None,
    }
}

/// 带 `ICON` 的目录条目。
fn in_dir_icon(title: &str, url: &str, folders: &[&str], icon: &str) -> ParsedBookmark {
    ParsedBookmark {
        icon: Some(icon.to_string()),
        ..in_dir(title, url, folders)
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
            // `bookmark_bar` 是**书签栏本身**、不是文件夹 → 它的子节点提升到根层。
            bm("A", "https://a.com/"),
            in_dir("B", "https://b.com/", &["组"]),
            // `other` 是「其他书签」，真文件夹 → 保留成一层。
            in_dir("C", "https://c.com/", &["其他"]),
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

#[test]
fn chromium_json_unnamed_folder_is_transparent() {
    // 没有 name 的 folder 不产生一层空目录名——它的子节点留在父层（不产出 `[""]` 这种路径段）。
    let raw = r#"{"roots":{"other":{"type":"folder","name":"其他","children":[
        {"type":"folder","children":[{"type":"url","name":"A","url":"https://a.com/"}]}
    ]}}}"#;
    assert_eq!(
        parse_chromium_json(raw).unwrap(),
        vec![in_dir("A", "https://a.com/", &["其他"])]
    );
}

// ── Netscape HTML ──

#[test]
fn netscape_html_keeps_folder_path_and_skips_structure_tags() {
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
        vec![
            in_dir("A 站", "https://a.com/", &["文件夹"]),
            in_dir("B 站", "https://b.com/", &["文件夹"]),
        ]
    );
}

#[test]
fn netscape_html_skips_personal_toolbar_root() {
    // 真实 Edge/Chrome 导出：最外层「收藏夹栏」是**书签栏本身**（PERSONAL_TOOLBAR_FOLDER="true"），
    // 不是文件夹——它的子目录才该成为栏上的顶层文件夹（否则每条都白挂一层「收藏夹栏」）。
    let raw = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1775" PERSONAL_TOOLBAR_FOLDER="true">收藏夹栏</H3>
    <DL><p>
        <DT><H3>工具</H3>
        <DL><p>
            <DT><A HREF="https://a.com/">A</A>
        </DL><p>
    </DL><p>
</DL><p>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![in_dir("A", "https://a.com/", &["工具"])]
    );
}

#[test]
fn netscape_html_nests_folders_by_dl_depth() {
    // 栈的进出：`</DL>` 之后必须回到**上一层**（工作层、再回根层），不能一直挂在最深那层。
    let raw = r#"<DL><p>
    <DT><H3>工作</H3>
    <DL><p>
        <DT><A HREF="https://w1.com/">W1</A>
        <DT><H3>漳蒲</H3>
        <DL><p>
            <DT><A HREF="https://z1.com/">Z1</A>
        </DL><p>
        <DT><A HREF="https://w2.com/">W2</A>
    </DL><p>
    <DT><A HREF="https://root.com/">根级</A>
</DL><p>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![
            in_dir("W1", "https://w1.com/", &["工作"]),
            in_dir("Z1", "https://z1.com/", &["工作", "漳蒲"]),
            in_dir("W2", "https://w2.com/", &["工作"]),
            bm("根级", "https://root.com/"),
        ]
    );
}

#[test]
fn netscape_html_decodes_folder_name_entities() {
    let raw = r#"<DL><p>
    <DT><H3>问答 &amp; 帮助</H3>
    <DL><p>
        <DT><A HREF="https://a.com/">A</A>
    </DL><p>
</DL><p>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![in_dir("A", "https://a.com/", &["问答 & 帮助"])]
    );
}

#[test]
fn netscape_html_blank_folder_name_is_transparent() {
    // 空名目录不产生空路径段（与 JSON 的匿名 folder 同一约定）。
    let raw = r#"<DL><p>
    <DT><H3>   </H3>
    <DL><p>
        <DT><A HREF="https://a.com/">A</A>
    </DL><p>
</DL><p>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![bm("A", "https://a.com/")]
    );
}

#[test]
fn netscape_html_unbalanced_dl_does_not_panic() {
    // 多出来的 `</DL>` 只能出栈到空，不能 panic / 不能把后续条目挂到幽灵目录上。
    let raw = r#"</DL></DL><DL><p>
    <DT><H3>组</H3>
    <DL><p>
        <DT><A HREF="https://a.com/">A</A>
    </DL><p>
</DL><p></DL><p></DL><p>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![in_dir("A", "https://a.com/", &["组"])]
    );
}

#[test]
fn netscape_html_supports_unquoted_href_and_entities() {
    // 顶层（无 <DL>）→ 根级；顺带覆盖无引号 href 与实体解码。
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
    // 标题与**目录名**走同一个解码器，两条路径各钉一次。
    let raw = r#"<DL><p>
    <DT><H3>x &amp;lt; y</H3>
    <DL><p>
        <DT><A HREF="https://a.com/">x &amp;lt; y</A>
    </DL><p>
</DL><p>"#;
    let parsed = parse_netscape_html(raw);
    assert_eq!(parsed[0].title, "x &lt; y");
    assert_eq!(parsed[0].folders, vec!["x &lt; y".to_string()]);
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

// ── 真实导出文件的形状（回归锚） ──

#[test]
fn real_edge_export_keeps_two_level_hierarchy() {
    // 用一份**真机导出**的最小复刻：收藏夹栏(工具栏根) → 工作 → 漳蒲。
    // 这条同时钉住两件事：工具栏根被丢弃、二级目录路径完整。
    let raw = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1775177557" LAST_MODIFIED="1788760877" PERSONAL_TOOLBAR_FOLDER="true">收藏夹栏</H3>
    <DL><p>
        <DT><H3 ADD_DATE="1601195070" LAST_MODIFIED="1787648642">工具</H3>
        <DL><p>
            <DT><A HREF="https://wanneng.run/x" ADD_DATE="1587708091" ICON="data:image/png;base64,iVBORw0KGgo=">万能命令</A>
            <DT><A HREF="https://mvnrepository.com/" ADD_DATE="1602462929" ICON="data:image/png;base64,AAAA">MvnJar</A>
        </DL><p>
        <DT><H3 ADD_DATE="1781744456" LAST_MODIFIED="1787880186">工作</H3>
        <DL><p>
            <DT><A HREF="https://tdiot.cloud/iotPlatform/#/index/status" ADD_DATE="1778718758">中科台达物联网平台</A>
            <DT><H3 ADD_DATE="1781744545" LAST_MODIFIED="0">漳蒲</H3>
            <DL><p>
                <DT><A HREF="https://zpcyy.insbazaar.com//loginPlatform#/choose-system" ADD_DATE="1776913871">福建省漳浦县现代农业产业园</A>
            </DL><p>
        </DL><p>
    </DL><p>
</DL><p>"#;
    assert_eq!(
        parse_netscape_html(raw),
        vec![
            in_dir_icon(
                "万能命令",
                "https://wanneng.run/x",
                &["工具"],
                "data:image/png;base64,iVBORw0KGgo="
            ),
            in_dir_icon(
                "MvnJar",
                "https://mvnrepository.com/",
                &["工具"],
                "data:image/png;base64,AAAA"
            ),
            in_dir(
                "中科台达物联网平台",
                "https://tdiot.cloud/iotPlatform/#/index/status",
                &["工作"]
            ),
            in_dir(
                "福建省漳浦县现代农业产业园",
                "https://zpcyy.insbazaar.com//loginPlatform#/choose-system",
                &["工作", "漳蒲"]
            ),
        ]
    );
}

// ── ICON 属性（站点图标） ──

#[test]
fn netscape_html_reads_icon_regardless_of_attribute_order() {
    // 真机导出的属性顺序不统一；早先按固定顺序写的正则会在这儿脆掉。
    let raw = r#"<DT><A HREF="https://a.com/" ICON="data:image/png;base64,AAA">A</A>
<DT><A ICON="data:image/png;base64,BBB" HREF="https://b.com/">B</A>"#;
    let parsed = parse_netscape_html(raw);
    assert_eq!(parsed[0].icon.as_deref(), Some("data:image/png;base64,AAA"));
    assert_eq!(parsed[1].icon.as_deref(), Some("data:image/png;base64,BBB"));
}

#[test]
fn netscape_html_without_icon_is_none() {
    // Chrome 旧版导出不带 ICON——那是"没有图标"，不是空字符串。
    let raw = r#"<DT><A HREF="https://a.com/">A</A>"#;
    assert_eq!(parse_netscape_html(raw)[0].icon, None);
    // 空的 ICON 属性也当没有（别把空串送进缓存层）。
    let raw = r#"<DT><A HREF="https://a.com/" ICON="">A</A>"#;
    assert_eq!(parse_netscape_html(raw)[0].icon, None);
}

#[test]
fn netscape_html_does_not_mistake_lookalike_attributes_for_icon() {
    // `LAST_ICON` / `ICON_URI` 都是别的属性：前者 `_` 与 `I` 之间没有词边界，后者后面不是 `=`。
    let raw = r#"<DT><A HREF="https://a.com/" LAST_ICON="https://x/i.png" ICON_URI="https://y/i.png">A</A>"#;
    assert_eq!(parse_netscape_html(raw)[0].icon, None);
}
