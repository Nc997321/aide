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
            skipped: 1,
            invalid: 1
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
            skipped: 0,
            invalid: 0
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
