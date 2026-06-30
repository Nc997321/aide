use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::pty::PtyManager;
use super::{WorkspaceState, project_root_for_commands, find_session_jsonl_globally};

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

    let mut env_vars = super::provider::load_active_provider()
        .map(|p| super::provider::provider_to_env_vars(&p))
        .unwrap_or_default();

    // Inject proxy env vars from settings
    if let Ok(s) = super::settings::get_settings() {
        if !s.proxy.is_empty() {
            env_vars.insert("HTTP_PROXY".to_string(), s.proxy.clone());
            env_vars.insert("HTTPS_PROXY".to_string(), s.proxy.clone());
            env_vars.insert("http_proxy".to_string(), s.proxy.clone());
            env_vars.insert("https_proxy".to_string(), s.proxy);
        }
    }

    let resume_id = if session_id.starts_with("new_") {
        None
    } else {
        find_claude_session_jsonl(&session_id)
    };

    if let Some(ref id) = resume_id {
        manager.spawn_command(&session_id, "claude", &["--resume", id.as_str()], &project_root, rows, cols, env_vars, app_handle)
    } else {
        manager.spawn_command(&session_id, "claude", &[], &project_root, rows, cols, env_vars, app_handle)
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

/// Decide whether Aide should pass `--resume <id>` when spawning Claude.
///
/// Claude's `--resume <id>` is global, so we look the transcript up by id
/// across every project folder rather than re-encoding the cwd. Otherwise,
/// when the .jsonl lives under a folder whose encoding differs from the
/// cwd-encoding Aide would compute (see `find_session_jsonl_globally`), Aide
/// would fail to find it, skip `--resume`, and silently start a brand-new
/// session instead of continuing the one the user clicked.
fn find_claude_session_jsonl(session_id: &str) -> Option<String> {
    if find_session_jsonl_globally(session_id).is_empty() {
        None
    } else {
        Some(session_id.to_string())
    }
}

/// Resolve the shell program path.
/// If `shell` is non-empty, use it verbatim. Otherwise probe by OS:
///   Windows: pwsh → powershell
///   Linux:   $SHELL → bash → sh
fn resolve_shell(shell: &str) -> Result<String, String> {
    if !shell.trim().is_empty() {
        return Ok(shell.to_string());
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(p) = which::which("pwsh") { return Ok(p.to_string_lossy().to_string()); }
        if let Ok(p) = which::which("powershell") { return Ok(p.to_string_lossy().to_string()); }
        return Err("Shell not found: install PowerShell or set shell_path in settings".to_string());
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(s) = std::env::var("SHELL") {
            if !s.is_empty() { return Ok(s); }
        }
        if let Ok(p) = which::which("bash") { return Ok(p.to_string_lossy().to_string()); }
        if let Ok(p) = which::which("sh") { return Ok(p.to_string_lossy().to_string()); }
        Err("Shell not found: set shell_path in settings".to_string())
    }
}

/// Spawn a general-purpose shell in a PTY (workbench terminal).
/// `session_id` is a fixed reserved id ("__workbench__"). `shell` empty → OS default.
#[tauri::command]
pub fn pty_spawn_shell(
    manager: State<'_, PtyManager>,
    app_handle: AppHandle,
    session_id: String,
    rows: u16,
    cols: u16,
    cwd: String,
    shell: String,
) -> Result<(), String> {
    let program = resolve_shell(&shell)?;
    let cwd_path = PathBuf::from(&cwd);
    manager.spawn_shell(&session_id, &program, &[], &cwd_path, rows, cols, app_handle)
}
