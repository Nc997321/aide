use std::collections::HashMap;

/// 文档是谁打开的。
///
/// **存在的唯一理由是隔离**：agent 查询路径会按需把文件递给 server（tsserver 只回答
/// 打开过的文档），而它递的那些文件用户多半从没打开过——server 对它们推的诊断如果照原样
/// 发到前端，用户界面上就会冒出「没打开过的文件在报错」。所以推送侧按来源过滤。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocOrigin {
    /// 编辑器打开的（用户真的开着这个文件）。
    Editor,
    /// agent 查询路径按需打开的。
    Agent,
}

#[derive(Debug, Clone)]
pub struct DocEntry {
    pub version: i64,
    pub text: String,
    pub origin: DocOrigin,
}

/// per-server 打开文档追踪。Full 同步：每次 change 整份 text，version 单调递增。
/// didOpen/didChange 发送时带 version；server 推诊断带的 version 与之比对丢旧（防闪烁）。
#[derive(Debug, Default)]
pub struct OpenDocs(HashMap<String, DocEntry>);

impl OpenDocs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&mut self, uri: String, text: String, origin: DocOrigin) {
        self.0.insert(
            uri,
            DocEntry {
                version: 1,
                text,
                origin,
            },
        );
    }

    /// 该文档的来源。未打开 → `None`（调用方据此决定要不要放行它的诊断）。
    pub fn origin_of(&self, uri: &str) -> Option<DocOrigin> {
        self.0.get(uri).map(|e| e.origin)
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
        d.open("file:///a.rs".into(), "fn main(){}".into(), DocOrigin::Editor);
        assert_eq!(d.synced_version("file:///a.rs"), Some(1));
        assert_eq!(d.get_text("file:///a.rs"), Some("fn main(){}"));
    }

    #[test]
    fn change_increments_version() {
        let mut d = OpenDocs::new();
        d.open("file:///a.rs".into(), "x".into(), DocOrigin::Editor);
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
        d.open("file:///a.rs".into(), "x".into(), DocOrigin::Editor);
        d.close("file:///a.rs");
        assert!(d.synced_version("file:///a.rs").is_none());
        assert!(!d.contains("file:///a.rs"));
    }

    #[test]
    fn synced_version_tracks_absent() {
        let d = OpenDocs::new();
        assert_eq!(d.synced_version("file:///none"), None);
    }

    /// 来源要记得住——推送侧就靠它把 agent 打开的文档的诊断挡在编辑器 UI 之外。
    #[test]
    fn origin_is_recorded_and_readable() {
        let mut d = OpenDocs::new();
        d.open("file:///agent.ts".into(), "x".into(), DocOrigin::Agent);
        d.open("file:///editor.ts".into(), "y".into(), DocOrigin::Editor);
        assert_eq!(d.origin_of("file:///agent.ts"), Some(DocOrigin::Agent));
        assert_eq!(d.origin_of("file:///editor.ts"), Some(DocOrigin::Editor));
        assert_eq!(d.origin_of("file:///never.ts"), None, "没打开过的文档没有来源");
    }
}
