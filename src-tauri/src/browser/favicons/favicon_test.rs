//! favicon 缓存单测：data URI 校验（收了什么 / 拒了什么）+ 两级查找（精确 → 同主机）+ 落盘往返。
//! 每个用例独占临时目录（进程 id + 用例名），可并行。

use std::fs;
use std::path::PathBuf;

use crate::browser::favicons::{decode_data_uri, FaviconStore, MAX_ICON_BYTES};

/// 一张最小的合法 PNG 头（内容不必是真图——校验只看 `data:` 头与体积，不解码像素）。
const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

fn png_uri() -> String {
    format!("data:image/png;base64,{PNG_B64}")
}

fn store(name: &str) -> FaviconStore {
    let dir = PathBuf::from(std::env::temp_dir()).join(format!(
        "aide-favicon-test-{}-{}",
        std::process::id(),
        name
    ));
    let _ = fs::remove_dir_all(&dir);
    FaviconStore::at(dir)
}

// ── data URI 校验 ──

#[test]
fn decode_accepts_png_data_uri() {
    let icon = decode_data_uri(&png_uri()).expect("合法 PNG data URI 应被接受");
    assert_eq!(icon.ext, "png");
    assert!(!icon.bytes.is_empty());
}

#[test]
fn decode_accepts_other_raster_types() {
    // 老导出器会给 ico / jpeg；这些是光栅格式，收。
    for (uri, ext) in [
        ("data:image/x-icon;base64,AAAA", "ico"),
        ("data:image/vnd.microsoft.icon;base64,AAAA", "ico"),
        ("data:image/jpeg;base64,AAAA", "jpg"),
        ("data:image/gif;base64,AAAA", "gif"),
        ("data:image/webp;base64,AAAA", "webp"),
    ] {
        let icon = decode_data_uri(uri).unwrap_or_else(|| panic!("{uri} 应被接受"));
        assert_eq!(icon.ext, ext, "{uri}");
    }
}

#[test]
fn decode_is_case_insensitive_about_header() {
    // data URI 的 scheme 与媒体类型大小写不敏感（导出器写法不一）。
    let uri = format!("DATA:IMAGE/PNG;BASE64,{PNG_B64}");
    assert_eq!(decode_data_uri(&uri).expect("大写头也应接受").ext, "png");
}

#[test]
fn decode_rejects_svg() {
    // **安全红线**：SVG 可以带 <script>。虽然在 <img> 里浏览器不执行，但图标不值得为它开这个口子。
    let uri = "data:image/svg+xml;base64,PHN2Zy8+";
    assert!(decode_data_uri(uri).is_none());
}

#[test]
fn decode_rejects_non_image_and_non_data() {
    assert!(decode_data_uri("data:text/html;base64,PHNjcmlwdD4=").is_none());
    assert!(decode_data_uri("https://a.com/favicon.ico").is_none());
    assert!(decode_data_uri("javascript:alert(1)").is_none());
    assert!(decode_data_uri("").is_none());
}

#[test]
fn decode_rejects_non_base64_payload() {
    // 少数导出器写的是百分号编码而不是 base64——那要另一套解码，这里明说不支持（宁可没图标）。
    assert!(decode_data_uri("data:image/png,%89PNG%0D%0A").is_none());
    // 声明了 base64 但内容不是合法 base64。
    assert!(decode_data_uri("data:image/png;base64,这不是base64!!!").is_none());
}

#[test]
fn decode_rejects_oversize_payload() {
    // 上限是"异常数据"的闸：真机 16×16 PNG 约 1 KB。
    let big = "A".repeat(MAX_ICON_BYTES * 2);
    assert!(decode_data_uri(&format!("data:image/png;base64,{big}")).is_none());
}

// ── 两级查找 ──

#[test]
fn put_then_get_returns_the_same_bytes() {
    let s = store("roundtrip");
    let icon = decode_data_uri(&png_uri()).unwrap();
    s.put("https://a.com/", &icon).expect("写图标应成功");

    let got = s.get("https://a.com/").expect("同 URL 应查到");
    assert!(got.starts_with("data:image/png;base64,"));
    assert!(got.ends_with(PNG_B64), "查回来的应是同一份字节");
}

#[test]
fn get_misses_when_nothing_stored() {
    let s = store("empty");
    assert!(s.get("https://a.com/").is_none());
}

#[test]
fn get_falls_back_to_host() {
    // 第四级回落的第二档：精确 URL 没有、但**同主机**有 → 用它。
    // 这是"导入文件里没带 ICON 的条目多半跟带图标的同域"的兑现处。
    let s = store("host-fallback");
    let icon = decode_data_uri(&png_uri()).unwrap();
    s.put("https://zhuanlan.zhihu.com/p/1", &icon).unwrap();

    assert!(s.get("https://zhuanlan.zhihu.com/p/2").is_some());
    // 别的域不许串味。
    assert!(s.get("https://other.com/").is_none());
}

#[test]
fn exact_wins_over_host() {
    // 同主机不同页面可能有不同图标（少见但要按 `精确 → 主机` 的顺序来）。
    let s = store("exact-wins");
    let a = decode_data_uri(&png_uri()).unwrap();
    let b = decode_data_uri("data:image/gif;base64,R0lGODlhAQABAAAAACw=").unwrap();

    s.put("https://a.com/one", &a).unwrap();
    s.put("https://a.com/two", &b).unwrap();

    assert!(
        s.get("https://a.com/two").unwrap().starts_with("data:image/gif"),
        "精确命中优先于同主机"
    );
    assert!(s.get("https://a.com/one").unwrap().starts_with("data:image/png"));
}

#[test]
fn lookup_normalizes_url_like_the_bookmark_store_does() {
    // 键与书签去重共用 url_guard 的归一化：`https://a.com` 与 `https://a.com/` 是同一条，
    // 否则导入存的图标会因为写法差异查不到（用户手打地址加书签就会撞上）。
    let s = store("normalize");
    let icon = decode_data_uri(&png_uri()).unwrap();
    s.put("https://a.com", &icon).expect("裸域应能写");
    assert!(s.get("https://a.com/").is_some(), "写法差异不该查不到");
}

#[test]
fn put_ignores_urls_that_fail_the_guard() {
    // 键来自 url_guard —— 过不了守门的 URL 连键都构不出来，什么也不写。
    let s = store("guard");
    let icon = decode_data_uri(&png_uri()).unwrap();
    assert!(s.put("javascript:alert(1)", &icon).is_err());
    assert!(s.get("javascript:alert(1)").is_none());
}

#[test]
fn urls_never_land_in_the_filename() {
    // 文件名是键的哈希：URL 里的 `/` `:` `?` 不能变成路径分隔符（否则写穿目录）。
    let s = store("hashed-name");
    let icon = decode_data_uri(&png_uri()).unwrap();
    s.put("https://a.com/deep/path?q=1&r=2", &icon).unwrap();

    let names: Vec<String> = fs::read_dir(s.dir())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "精确 + 主机各一份：{names:?}");
    for n in &names {
        let (stem, ext) = n.split_once('.').unwrap_or_else(|| panic!("应有扩展名：{n}"));
        assert!(
            stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit()),
            "主干应是 sha256 十六进制（URL 不进文件名），实际：{n}"
        );
        assert_eq!(ext, "png", "扩展名应取自图标类型，实际：{n}");
    }
}
