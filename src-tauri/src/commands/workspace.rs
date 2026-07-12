use std::fs;
use std::path::PathBuf;
use tauri::State;

use super::{WorkspaceInfo, WorkspaceState, claude_projects_dir};

/// 路径 → 编码 key：把 : \ / 替换为 -，与 Claude CLI
/// `~/.claude/projects/` 目录命名一致。
pub fn path_to_key(path: &str) -> String {
    path.chars()
        .map(|c| match c {
            ':' | '\\' | '/' => '-',
            other => other,
        })
        .collect()
}

/// 从工作区列表里滤掉黑名单中的 key（隐藏语义）。
pub fn filter_hidden(infos: Vec<WorkspaceInfo>, hidden: &[String]) -> Vec<WorkspaceInfo> {
    infos.into_iter().filter(|w| !hidden.contains(&w.key)).collect()
}

#[tauri::command]
pub fn list_workspaces() -> Result<Vec<WorkspaceInfo>, String> {
    let dir = claude_projects_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut workspaces = Vec::new();
    let read_dir = fs::read_dir(&dir).map_err(|e| format!("Failed to read projects dir: {}", e))?;
    for entry in read_dir {
        let Ok(entry) = entry else { continue; };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let key = entry.file_name().to_string_lossy().to_string();
            let resolved = resolve_path_from_key(&key);
            let missing = resolved.is_none();
            let name = resolved.unwrap_or_else(|| key.clone());
            workspaces.push(WorkspaceInfo { key, name, missing });
        }
    }
    Ok(workspaces)
}

#[tauri::command]
pub fn set_workspace(
    workspace_state: State<'_, WorkspaceState>,
    key: String,
    path: String,
) -> Result<(), String> {
    {
        let mut k = workspace_state.key.lock().map_err(|e| e.to_string())?;
        *k = Some(key.clone());
    }
    {
        let mut p = workspace_state.path.lock().map_err(|e| e.to_string())?;
        *p = Some(PathBuf::from(path));
    }
    let _ = save_workspace_config(&key);
    Ok(())
}

pub fn load_workspace_config() -> Option<String> {
    let config = super::settings::load_config();
    config.get("workspace").and_then(|w| w.as_str()).map(|s| s.to_string())
}

fn save_workspace_config(path: &str) -> Result<(), String> {
    let mut config = super::settings::load_config();
    if config.is_null() {
        config = serde_json::json!({});
    }
    config["workspace"] = serde_json::Value::String(path.to_string());
    super::settings::save_config(&config)
}

pub fn resolve_path_from_key(key: &str) -> Option<String> {
    let mut chars = key.chars();
    let drive = chars.next()?;
    chars.next()?;
    chars.next()?;
    let rest: String = chars.collect();
    if rest.is_empty() {
        let path = format!("{}:\\", drive);
        return if PathBuf::from(&path).exists() { Some(path) } else { None };
    }
    try_decode(&format!("{}:\\", drive), &rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::WorkspaceInfo;

    #[test]
    fn path_to_key_windows_path() {
        assert_eq!(path_to_key(r"C:\Users\yangx\proj"), "C--Users-yangx-proj");
    }

    #[test]
    fn path_to_key_unix_path() {
        assert_eq!(path_to_key("/Users/x/proj"), "-Users-x-proj");
    }

    #[test]
    fn path_to_key_preserves_other_chars() {
        // 空格、中文、点不替换
        assert_eq!(path_to_key(r"C:\my project\文档.git"), "C--my project-文档.git");
    }

    #[test]
    fn filter_hidden_empty_passthrough() {
        let infos = vec![sample("k1"), sample("k2")];
        let hidden: Vec<String> = vec![];
        assert_eq!(filter_hidden(infos, &hidden).len(), 2);
    }

    #[test]
    fn filter_hidden_filters_matching() {
        let infos = vec![sample("k1"), sample("k2"), sample("k3")];
        let hidden = vec!["k2".to_string()];
        let out = filter_hidden(infos, &hidden);
        assert_eq!(out.iter().map(|w| w.key.clone()).collect::<Vec<_>>(), vec!["k1", "k3"]);
    }

    #[test]
    fn filter_hidden_multiple() {
        let infos = vec![sample("a"), sample("b"), sample("c")];
        let hidden = vec!["a".to_string(), "c".to_string()];
        let out = filter_hidden(infos, &hidden);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].key, "b");
    }

    fn sample(key: &str) -> WorkspaceInfo {
        WorkspaceInfo { key: key.to_string(), name: key.to_string(), missing: false }
    }
}

fn try_decode(prefix: &str, remaining: &str) -> Option<String> {
    for (i, ch) in remaining.char_indices() {
        if ch == '-' {
            let component = &remaining[..i];
            let candidate = format!("{}{}", prefix, component);
            if !component.is_empty() && PathBuf::from(&candidate).exists() {
                let next_prefix = format!("{}{}\\", prefix, component);
                if let Some(result) = try_decode(&next_prefix, &remaining[i + 1..]) {
                    return Some(result);
                }
            }
        }
    }
    let final_path = format!("{}{}", prefix, remaining);
    if PathBuf::from(&final_path).exists() { Some(final_path) } else { None }
}
