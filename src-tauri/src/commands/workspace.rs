use std::fs;
use std::path::PathBuf;
use tauri::State;

use super::{WorkspaceInfo, WorkspaceState, claude_projects_dir};

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
            let name = resolve_path_from_key(&key).unwrap_or_else(|| key.clone());
            workspaces.push(WorkspaceInfo { key, name });
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

fn resolve_path_from_key(key: &str) -> Option<String> {
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
