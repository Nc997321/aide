//! 路径解析与 confinement：memory 目录定位、observatory 自有数据目录、文件名校验。
//!
//! memory 目录解析复用工作区模块的 `resolve_project_dirs`（dot 归一多目录
//! 合并——同一工作区可能因编码版本分裂成两个 projects 目录，见 workspace/mod.rs
//! 2026-07-24 注释），取每个命中目录下的 `memory/` 子目录。

use std::path::PathBuf;

use crate::commands::workspace::resolve_project_dirs;
use crate::paths::{claude_home, claude_projects_dir, our_config_dir};

/// 当前工作区对应的所有 memory 目录（只保留实际存在的）。
pub fn memory_dirs(workspace_key: &str) -> Vec<PathBuf> {
    resolve_project_dirs(&claude_projects_dir(), workspace_key)
        .into_iter()
        .map(|d| d.join("memory"))
        .filter(|d| d.is_dir())
        .collect()
}

/// 用户级全局指令：~/.aide/claude/CLAUDE.md（每会话全量加载，观测台只展示）。
pub fn claude_md_path() -> PathBuf {
    claude_home().join("CLAUDE.md")
}

/// 观测台自有数据根目录：~/.aide/observatory/（app 自有，不写进 Claude 的 projects 目录）。
pub fn observatory_dir() -> PathBuf {
    our_config_dir().join("observatory")
}

pub fn snapshots_dir() -> PathBuf {
    observatory_dir().join("snapshots")
}

/// 事件台账：sidecar memoryEvents hook append 的 JSONL（~/.aide/observatory/events.jsonl）。
pub fn events_log() -> PathBuf {
    observatory_dir().join("events.jsonl")
}

/// 当前 Unix 毫秒。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 文件名 confinement：只允许裸 `.md` 文件名——拒绝分隔符 / 绝对路径 / `.` `..`，
/// 防路径穿越。观测台全部文件操作（读/删）都必须先过这道校验。
pub fn confine_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("empty file name".into());
    }
    if n == "." || n == ".." {
        return Err("illegal file name".into());
    }
    if n.contains('/') || n.contains('\\') || n.contains(':') {
        return Err("name must be a bare file name, no path separators".into());
    }
    if !n.ends_with(".md") {
        return Err("only .md files are observable".into());
    }
    Ok(n.to_string())
}

/// 在多个 memory 目录里定位同名文件，返回实际存在的完整路径列表。
pub fn locate(dirs: &[PathBuf], name: &str) -> Vec<PathBuf> {
    dirs.iter()
        .map(|d| d.join(name))
        .filter(|p| p.is_file())
        .collect()
}

/// SystemTime → Unix 毫秒（i64；1970 前或异常归 None）。
pub fn to_ms(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confine_accepts_bare_md() {
        assert_eq!(confine_name("note.md").unwrap(), "note.md");
        assert_eq!(confine_name(" MEMORY.md ").unwrap(), "MEMORY.md");
    }

    #[test]
    fn confine_rejects_traversal_and_separators() {
        for bad in [
            "..",
            "../x.md",
            "a/b.md",
            "a\\b.md",
            "C:\\x.md",
            "/abs/x.md",
            "",
            "note.txt",
            ".",
        ] {
            assert!(confine_name(bad).is_err(), "should reject: {bad:?}");
        }
    }
}
