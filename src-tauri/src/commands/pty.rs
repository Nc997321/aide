use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::pty::PtyManager;
use super::{WorkspaceState, project_root_for_commands, encode_project_path, claude_projects_dir};

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, session_id: String, data: String) -> Result<(), String> {
    manager.write(&session_id, &data)
}

#[tauri::command]
pub fn pty_resize(manager: State<'_, PtyManager>, session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    manager.resize(&session_id, rows, cols)
}

#[tauri::command]
pub fn pty_spawn_claude(
    manager: State<'_, PtyManager>,
    workspace_state: State<'_, WorkspaceState>,
    app_handle: AppHandle,
    rows: u16,
    cols: u16,
    session_id: String,
) -> Result<(), String> {
    let project_root = project_root_for_commands(&workspace_state);

    let resume_id = if session_id.starts_with("new_") {
        None
    } else {
        find_claude_session_jsonl(&session_id, &project_root)
    };

    if let Some(ref id) = resume_id {
        manager.spawn_command(&session_id, "claude", &["--resume", id.as_str()], &project_root, rows, cols, app_handle)
    } else {
        manager.spawn_command(&session_id, "claude", &[], &project_root, rows, cols, app_handle)
    }
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, session_id: String) -> Result<(), String> {
    manager.kill_session(&session_id);
    Ok(())
}

#[tauri::command]
pub fn pty_has_session(manager: State<'_, PtyManager>, session_id: String) -> Result<bool, String> {
    Ok(manager.has_session(&session_id))
}

#[tauri::command]
pub fn pty_rename_session(manager: State<'_, PtyManager>, old_id: String, new_id: String) -> Result<(), String> {
    manager.rename_session(&old_id, &new_id);
    Ok(())
}

/// Poll accumulated PTY output for a session.
/// The frontend calls this periodically instead of receiving push events,
/// giving it full control over the data consumption rate.
#[tauri::command]
pub fn poll_pty_output(manager: State<'_, PtyManager>, session_id: String) -> Result<String, String> {
    manager.poll_output(&session_id)
}

fn find_claude_session_jsonl(session_id: &str, project_root: &PathBuf) -> Option<String> {
    let encoded = encode_project_path(&project_root.to_string_lossy());
    let jsonl_path = claude_projects_dir()
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));
    if jsonl_path.exists() {
        Some(session_id.to_string())
    } else {
        None
    }
}
