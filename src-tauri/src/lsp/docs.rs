use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct DocEntry {
    pub version: i64,
    pub text: String,
}

/// per-server 打开文档追踪。Full 同步：每次 change 整份 text，version 单调递增。
/// didOpen/didChange 发送时带 version；server 推诊断带的 version 与之比对丢旧（防闪烁）。
#[derive(Debug, Default)]
pub struct OpenDocs(HashMap<String, DocEntry>);

impl OpenDocs {
    pub fn new() -> Self { Self::default() }

    pub fn open(&mut self, uri: String, text: String) {
        self.0.insert(uri, DocEntry { version: 1, text });
    }

    /// 整份替换 text，version++，返回新 version。调用前须已 open（panic 否则）。
    pub fn change(&mut self, uri: &str, text: String) -> i64 {
        let e = self.0.get_mut(uri).expect("change before open");
        e.version += 1;
        e.text = text;
        e.version
    }

    pub fn close(&mut self, uri: &str) {
        self.0.remove(uri);
    }

    pub fn contains(&self, uri: &str) -> bool {
        self.0.contains_key(uri)
    }
}

/// 测试断言用查询器：生产路径只 open/change/close/contains（version 经 `change`
/// 返回值直接喂给 didChange 通知；诊断版本比对丢旧 v1 在前端做）。仅 `#[cfg(test)]`
/// 编译，避免 dead_code 警告；将来若在 Rust 侧做诊断版本比对或 hover 取 buffer 文本再提回主 impl。
#[cfg(test)]
impl OpenDocs {
    /// 当前已同步 version（open=1，change 递增）。
    pub fn synced_version(&self, uri: &str) -> Option<i64> {
        self.0.get(uri).map(|e| e.version)
    }

    /// 当前整份 text。
    pub fn get_text(&self, uri: &str) -> Option<&str> {
        self.0.get(uri).map(|e| e.text.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_sets_version_1() {
        let mut d = OpenDocs::new();
        d.open("file:///a.rs".into(), "fn main(){}".into());
        assert_eq!(d.synced_version("file:///a.rs"), Some(1));
        assert_eq!(d.get_text("file:///a.rs"), Some("fn main(){}"));
    }

    #[test]
    fn change_increments_version() {
        let mut d = OpenDocs::new();
        d.open("file:///a.rs".into(), "x".into());
        let v2 = d.change("file:///a.rs", "xy".into());
        assert_eq!(v2, 2);
        let v3 = d.change("file:///a.rs", "xyz".into());
        assert_eq!(v3, 3);
        assert_eq!(d.synced_version("file:///a.rs"), Some(3));
        assert_eq!(d.get_text("file:///a.rs"), Some("xyz"));
    }

    #[test]
    fn close_removes() {
        let mut d = OpenDocs::new();
        d.open("file:///a.rs".into(), "x".into());
        d.close("file:///a.rs");
        assert!(d.synced_version("file:///a.rs").is_none());
        assert!(!d.contains("file:///a.rs"));
    }

    #[test]
    fn synced_version_tracks_absent() {
        let d = OpenDocs::new();
        assert_eq!(d.synced_version("file:///none"), None);
    }
}
