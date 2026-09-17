//! 书签存储单测：落盘往返 / 按 URL 幂等 / `url_guard` 守门 / 导入合并与如实上报 / 坏文件隔离。
//! 每个用例独占临时目录（进程 id + 用例名），可并行。

use std::fs;
use std::path::PathBuf;

use crate::browser::bookmarks::{BookmarkStore, ImportReport, StoreError};

fn store(name: &str) -> BookmarkStore {
    let dir = PathBuf::from(std::env::temp_dir()).join(format!(
        "aide-bm-test-{}-{}",
        std::process::id(),
        name
    ));
    let _ = fs::remove_dir_all(&dir);
    BookmarkStore::at(dir.join("bookmarks.json"))
}

#[test]
fn add_persists_and_survives_new_store_instance() {
    let s = store("roundtrip");
    s.add("A 站", "https://a.com").unwrap();
    s.add("B 站", "https://b.com/").unwrap();

    // 换一个实例读同一个路径 → 数据来自磁盘而不是内存。
    let reread = BookmarkStore::at(s.path().to_path_buf());
    let list = reread.list().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].title(), "A 站");
    assert_eq!(list[0].url(), "https://a.com/"); // url_guard 归一化后的形态
    assert_eq!(list[1].title(), "B 站");
    assert!(list[0].added_at() > 0);
}

#[test]
fn add_is_idempotent_by_normalized_url() {
    let s = store("idempotent");
    let first = s.add("A", "https://a.com").unwrap();
    // 同一条的两副写法（裸域 vs 归一）→ 不新增，返回既有那条。
    let again = s.add("A 重复", "https://a.com/").unwrap();
    assert_eq!(first, again);
    assert_eq!(s.list().unwrap().len(), 1);
}

#[test]
fn add_rejects_dangerous_scheme_and_writes_nothing() {
    let s = store("guard");
    assert!(matches!(
        s.add("坏", "javascript:alert(1)"),
        Err(StoreError::UrlRejected(_))
    ));
    assert!(s.list().unwrap().is_empty());
    assert!(!s.path().exists());
}

#[test]
fn blank_title_falls_back_to_url() {
    let s = store("blank-title");
    let bm = s.add("   ", "https://a.com/").unwrap();
    assert_eq!(bm.title(), "https://a.com/");
}

#[test]
fn remove_reports_whether_it_hit() {
    let s = store("remove");
    let bm = s.add("A", "https://a.com/").unwrap();
    assert!(s.remove(bm.id()).unwrap());
    assert!(!s.remove(bm.id()).unwrap()); // 未知/已删 → false，不报错（UI 删除幂等）
    assert!(s.list().unwrap().is_empty());
}

#[test]
fn import_merges_dedupes_and_reports_honestly() {
    let s = store("import");
    s.add("已有", "https://exists.com/").unwrap();

    let html = r#"<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DT><A HREF="https://new1.com/">新一</A>
<DT><A HREF="https://exists.com/">重复</A>
<DT><A HREF="javascript:alert(1)">非法</A>
<DT><A HREF="https://new2.com/">新二</A>"#;

    assert_eq!(
        s.import(html).unwrap(),
        ImportReport {
            added: 2,
            adopted: 0,
            skipped: 1,
            invalid: 1, icons: 0
        }
    );
    let list = s.list().unwrap();
    assert_eq!(list.len(), 3); // 既有那条还在（导入只增不删）
    assert_eq!(list[0].title(), "已有");
}

#[test]
fn import_accepts_chromium_json() {
    let s = store("import-json");
    let raw = r#"{"roots":{"bookmark_bar":{"children":[
        {"type":"url","name":"A","url":"https://a.com/"}
    ]}}}"#;
    assert_eq!(
        s.import(raw).unwrap(),
        ImportReport {
            added: 1,
            adopted: 0,
            skipped: 0,
            invalid: 0, icons: 0
        }
    );
    assert_eq!(s.list().unwrap()[0].title(), "A");
}

#[test]
fn import_with_nothing_new_does_not_touch_the_file() {
    let s = store("import-noop");
    s.add("A", "https://a.com/").unwrap();
    let before = fs::read_to_string(s.path()).unwrap();
    assert_eq!(
        s.import(r#"<DT><A HREF="https://a.com/">A</A>"#)
            .unwrap()
            .added,
        0
    );
    assert_eq!(fs::read_to_string(s.path()).unwrap(), before);
}

// ── 目录（v2） ──

/// 把一条 URL 包进指定目录路径的 Netscape 片段（测试用最小形状）。
fn html_in_dir(url: &str, title: &str, dirs: &[&str]) -> String {
    html_in_dir_full(url, title, dirs, None)
}

/// 同上，可选带 `ICON` 属性。
fn html_in_dir_full(url: &str, title: &str, dirs: &[&str], icon: Option<&str>) -> String {
    let mut open = String::new();
    let mut close = String::new();
    for d in dirs {
        open.push_str(&format!("<DL><p><DT><H3>{d}</H3>"));
        close.push_str("</DL><p>");
    }
    let icon_attr = icon.map(|i| format!(" ICON=\"{i}\"")).unwrap_or_default();
    format!("{open}<DL><p><DT><A HREF=\"{url}\"{icon_attr}>{title}</A>{close}")
}

/// 一条合法的 `ICON` 值。**内容不必是真图**——校验只看 `data:` 头与 base64，不解码像素。
const ICON: &str = "data:image/png;base64,AAAA";

#[test]
fn add_lands_at_bar_root() {
    // ★ 收藏没有"选目录"这一步（UI 没这个入口）→ 落在根层。将来加目录选择器再改这里。
    let s = store("add-root");
    assert!(s.add("A", "https://a.com/").unwrap().folders().is_empty());
}

#[test]
fn folder_path_survives_save_and_load() {
    let s = store("folder-roundtrip");
    s.import(&html_in_dir("https://z.com/", "Z", &["工作", "漳蒲"]))
        .unwrap();

    // 换实例从磁盘读 → 多层路径逐段还原（不是只存了最深那层）。
    let reread = BookmarkStore::at(s.path().to_path_buf());
    assert_eq!(
        reread.list().unwrap()[0].folders(),
        vec!["工作".to_string(), "漳蒲".to_string()]
    );
}

#[test]
fn import_adopts_folder_for_existing_folderless_bookmark() {
    // **用户不用删数据的那条路**：先按 v1 扁平导过一轮（库里没目录），再导同一份带目录的文件
    // → 原位补上目录，不新增、也不算"重复跳过"。
    let s = store("adopt");
    s.add("A", "https://a.com/").unwrap();

    assert_eq!(
        s.import(&html_in_dir("https://a.com/", "A", &["工具"]))
            .unwrap(),
        ImportReport {
            added: 0,
            adopted: 1,
            skipped: 0,
            invalid: 0, icons: 0
        }
    );
    let list = s.list().unwrap();
    assert_eq!(list.len(), 1, "认领是原位更新，不是新增一条");
    assert_eq!(list[0].folders(), vec!["工具".to_string()]);
}

#[test]
fn import_does_not_clobber_an_existing_folder() {
    // 库里那条已经有目录（认领过 / 将来手动整理过）→ 重复导入不动它（只计 skipped）。
    let s = store("no-clobber");
    s.import(&html_in_dir("https://a.com/", "A", &["工具"]))
        .unwrap();

    assert_eq!(
        s.import(&html_in_dir("https://a.com/", "A", &["娱乐"]))
            .unwrap(),
        ImportReport {
            added: 0,
            adopted: 0,
            skipped: 1,
            invalid: 0, icons: 0
        }
    );
    assert_eq!(s.list().unwrap()[0].folders(), vec!["工具".to_string()]);
}

#[test]
fn import_adopting_only_writes_the_file_once() {
    // 认领也要落盘（否则刷新就回退了），且"认领 + 新增"同一趟里两类都要保下来。
    let s = store("adopt-persist");
    s.add("老", "https://old.com/").unwrap();

    let mut raw = html_in_dir("https://old.com/", "老", &["工具"]);
    raw.push_str(&html_in_dir("https://new.com/", "新", &["娱乐"]));

    assert_eq!(
        s.import(&raw).unwrap(),
        ImportReport {
            added: 1,
            adopted: 1,
            skipped: 0,
            invalid: 0, icons: 0
        }
    );
    let reread = BookmarkStore::at(s.path().to_path_buf());
    let list = reread.list().unwrap();
    assert_eq!(list[0].folders(), vec!["工具".to_string()]);
    assert_eq!(list[1].folders(), vec!["娱乐".to_string()]);
}

#[test]
fn v1_file_without_folders_loads_as_root_level() {
    // 老文件（schema v1：没有 folders 字段）必须原样读进来，那批条目就是"根级、待认领目录"。
    // 这是「再导一次就自愈」的前提——不兼容的话用户得手删 bookmarks.json。
    let s = store("v1-compat");
    fs::create_dir_all(s.path().parent().unwrap()).unwrap();
    fs::write(
        s.path(),
        r#"{"version":1,"bookmarks":[
            {"id":"bm-1-0","title":"A","url":"https://a.com/","added_at":1}
        ]}"#,
    )
    .unwrap();

    let list = s.list().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].title(), "A");
    assert!(list[0].folders().is_empty());
}

// ── 图标（导入种入图标缓存） ──

#[test]
fn import_seeds_the_favicon_cache_by_url() {
    // 导入把 `ICON` 种进**按 URL 索引的独立缓存**——书签记录本身不存图标（业界同构：图标是
    // 页面的属性，不是某条书签的属性）。
    let s = store("seed-icon");
    let report = s
        .import(&html_in_dir_full("https://a.com/", "A", &["工具"], Some(ICON)))
        .unwrap();
    assert_eq!(report.icons, 1, "报告里要能看见图标进来了几条");

    let got = s.favicons().get("https://a.com/").expect("导入后应能查到图标");
    assert!(got.starts_with("data:image/png;base64,"));
}

#[test]
fn import_seeds_host_fallback_too() {
    // 同主机回落靠"导入时精确与主机两级都写"兑现：同域下没带 ICON 的那条也能查到图标。
    let s = store("seed-host");
    s.import(&html_in_dir_full("https://a.com/one", "一", &[], Some(ICON)))
        .unwrap();

    assert!(
        s.favicons().get("https://a.com/two").is_some(),
        "同域另一条应能回落到主机级图标"
    );
}

#[test]
fn a_bad_icon_never_fails_the_import() {
    // 图标是**装饰**：非法/超限/带脚本的 ICON 只该被丢掉，绝不能让整条导入失败。
    let s = store("bad-icon");
    let mut raw = html_in_dir_full("https://a.com/", "A", &[], Some("not-a-data-uri"));
    raw.push_str(&html_in_dir_full(
        "https://b.com/",
        "B",
        &[],
        Some("data:image/svg+xml;base64,PHN2Zy8+"),
    ));

    let report = s.import(&raw).unwrap();
    assert_eq!(report.added, 2, "两条书签都该进来");
    assert_eq!(report.icons, 0, "坏图标一条都不该计数");
    assert!(s.favicons().get("https://a.com/").is_none());
    assert!(
        s.favicons().get("https://b.com/").is_none(),
        "SVG 不收——图标不值得为它开脚本的口子"
    );
}

#[test]
fn saved_bookmarks_carry_no_icon_field() {
    // 图标**不进书签文件**：书签里存图标会让每次列表面包都背上几十 KB 的 base64。
    let s = store("no-icon-in-json");
    s.import(&html_in_dir_full("https://a.com/", "A", &[], Some(ICON)))
        .unwrap();

    let raw = fs::read_to_string(s.path()).unwrap();
    assert!(!raw.contains("data:image"), "书签文件里不该出现图标数据");
}

#[test]
fn saving_writes_schema_version_2() {
    // 版本号是给将来的自己看的：写下 v2 才算真的"认了目录"这件事。
    let s = store("version-bump");
    s.add("A", "https://a.com/").unwrap();
    let raw = fs::read_to_string(s.path()).unwrap();
    assert!(
        raw.contains("\"version\": 2"),
        "落盘应为 schema v2，实际：{raw}"
    );
}

#[test]
fn corrupt_file_is_quarantined_and_store_keeps_working() {
    let s = store("corrupt");
    s.add("A", "https://a.com/").unwrap();
    fs::write(s.path(), "{ 这不是 json").unwrap();

    // 坏文件 → 按空库继续（不把整个功能挂掉），且原文件被隔离保留在磁盘上。
    assert!(s.list().unwrap().is_empty());
    let dir = s.path().parent().unwrap();
    let quarantined = fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().contains("corrupt-"));
    assert!(
        quarantined,
        "坏文件应被改名为 .corrupt-<ms> 保留，而不是被静默删掉"
    );

    // 之后照常可用。
    s.add("B", "https://b.com/").unwrap();
    assert_eq!(s.list().unwrap().len(), 1);
}
