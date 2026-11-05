use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct SourceFile {
    pub path: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DraftTarget {
    pub draft_key: String,
    pub expected_revision: Option<String>,
    pub selection: Option<Selection>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct OpenRequest {
    pub files: Vec<SourceFile>,
    pub selected: usize,
    pub target: DraftTarget,
    pub theme: Option<HashMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct FileInfo {
    pub handle: String,
    pub path: String,
    pub mime: String,
    pub size: u64,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Selection {
    Point { #[serde(rename = "atMs")] at_ms: u64 },
    Range { #[serde(rename = "startMs")] start_ms: u64, #[serde(rename = "endMs")] end_ms: u64 },
}

impl Selection {
    pub fn validate(&self) -> Result<(), String> {
        const MAX_TIME: u64 = 7 * 24 * 60 * 60 * 1000;
        let valid = match self {
            Self::Point { at_ms } => *at_ms <= MAX_TIME,
            Self::Range { start_ms, end_ms } => start_ms < end_ms && *end_ms <= MAX_TIME,
        };
        valid.then_some(()).ok_or_else(|| "媒体引用时间无效".to_string())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Frame {
    pub data: String,
    pub media_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum PageAction {
    Select { #[serde(rename = "fileId")] file_id: String },
    Reference { selection: Selection, frame: Option<Frame>, revision: String },
    Save,
    OpenExternal,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FeedbackOutcome {
    pub error: Option<String>,
}

pub(crate) fn validate_request(request: &OpenRequest) -> Result<(), String> {
    if request.files.is_empty() || request.files.len() > 32 || request.selected >= request.files.len() {
        return Err("请选择一个有效媒体文件（单次最多 32 个）".into());
    }
    if request.target.draft_key.is_empty() || request.target.draft_key.len() > 512 {
        return Err("找不到媒体引用所属会话".into());
    }
    if let Some(selection) = &request.target.selection { selection.validate()?; }
    for file in &request.files {
        if !valid_path(&file.path) || file.title.len() > 800 {
            return Err("媒体路径或标题无效，请重新交付文件".into());
        }
    }
    Ok(())
}

fn valid_path(path: &str) -> bool {
    let absolute = path.starts_with('/') || std::path::Path::new(path).is_absolute()
        || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes().get(2).is_some_and(|b| matches!(b, b'/' | b'\\')));
    absolute && path.len() <= 4096 && !path.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn references_require_ordered_bounded_integer_times() {
        assert!(Selection::Point { at_ms: 0 }.validate().is_ok());
        assert!(Selection::Range { start_ms: 4, end_ms: 4 }.validate().is_err());
        assert!(Selection::Point { at_ms: u64::MAX }.validate().is_err());
        assert!(serde_json::from_str::<Selection>(r#"{"kind":"point","atMs":-1}"#).is_err());
        assert!(serde_json::from_str::<Selection>(r#"{"kind":"point","atMs":1.1}"#).is_err());
    }
    #[test]
    fn only_explicit_native_absolute_paths_are_accepted() {
        for path in ["/home/project/a.mp4", "C:/clips/a.wav", "C:\\clips\\a.wav"] { assert!(valid_path(path)); }
        for path in ["../a.mp4", "https://example.test/a.mp4", "/tmp/a\n.mp4"] { assert!(!valid_path(path)); }
    }
}
