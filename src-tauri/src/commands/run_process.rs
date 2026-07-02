use std::path::PathBuf;
use tauri::{AppHandle, State};
use crate::shell::ShellManager;

fn run_session_id(config_id: &str) -> String {
    format!("run__{}", config_id)
}

#[tauri::command]
pub fn run_process_start(
    config_id: String,
    cwd: String,
    command: String,
    pty_manager: State<'_, ShellManager>,
    app: AppHandle,
) -> Result<String, String> {
    let session_id = run_session_id(&config_id);
    let cwd_path = PathBuf::from(&cwd);
    pty_manager.spawn_run_command(&session_id, &cwd_path, &command, 24, 80, app)?;
    Ok(session_id)
}

#[tauri::command]
pub fn run_process_stop(
    config_id: String,
    pty_manager: State<'_, ShellManager>,
) -> Result<(), String> {
    let session_id = run_session_id(&config_id);
    pty_manager.kill_session(&session_id);
    Ok(())
}
