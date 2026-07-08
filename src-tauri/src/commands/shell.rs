use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::shell::ShellManager;

#[tauri::command]
pub fn pty_write(manager: State<'_, ShellManager>, session_id: String, data: String) -> Result<(), String> {
    manager.write(&session_id, &data)
}

#[tauri::command]
pub fn pty_resize(manager: State<'_, ShellManager>, session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    manager.resize(&session_id, rows, cols)
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, ShellManager>, session_id: String) -> Result<(), String> {
    manager.kill_session(&session_id);
    Ok(())
}

/// Poll accumulated PTY output for a session.
/// The frontend calls this periodically instead of receiving push events,
/// giving it full control over the data consumption rate.
#[tauri::command]
pub fn poll_pty_output(manager: State<'_, ShellManager>, session_id: String) -> Result<String, String> {
    manager.poll_output(&session_id)
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
/// `shell` empty → OS default shell.
#[tauri::command]
pub fn pty_spawn_shell(
    manager: State<'_, ShellManager>,
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

#[tauri::command]
pub async fn scan_plugin_skills(
    provider: Option<String>,
    cwd: String,
    registry: tauri::State<'_, std::sync::Arc<crate::skills::SkillRegistry>>,
) -> Result<Vec<crate::skills::SkillMeta>, String> {
    let reg = registry.inner().clone();
    let path = std::path::Path::new(&cwd).to_path_buf();
    tokio::task::spawn_blocking(move || reg.list(provider.as_deref(), &path))
        .await
        .map_err(|e| format!("scan_plugin_skills task panicked: {}", e))
}
