use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::State;

use super::{WorkspaceInfo, WorkspaceState, claude_projects_dir, our_config_dir, config_path};

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
    let path = config_path();
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                return v.get("workspace").and_then(|w| w.as_str()).map(|s| s.to_string());
            }
        }
    }
    None
}

fn save_workspace_config(path: &str) -> Result<(), String> {
    let dir = our_config_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {}", e))?;
    let json = serde_json::json!({ "workspace": path });
    fs::write(config_path(), serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to write config: {}", e))
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
