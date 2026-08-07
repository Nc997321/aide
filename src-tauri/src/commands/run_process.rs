use std::collections::BTreeMap;
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
    env: BTreeMap<String, String>,
    rows: u16,
    cols: u16,
    pty_manager: State<'_, ShellManager>,
    app: AppHandle,
) -> Result<String, String> {
    let _trace = crate::diagnostics::trace_command("run_process_start");
    let session_id = run_session_id(&config_id);
    let cwd_path = PathBuf::from(&cwd);
    // rows/cols 由前端 fit 出 xterm 真实尺寸后传入——ConPTY 从第一帧起即与 xterm
    // 列宽一致，避免用固定 80 列 spawn 导致长行被提前 wrap 割裂（spawn→resize
    // 窗口期内的输出按错误列宽渲染会永久留在 buffer 里）。
    pty_manager.spawn_run_command(&session_id, &cwd_path, &command, &env, rows, cols, app)?;
    Ok(session_id)
}

#[tauri::command]
pub fn run_process_stop(
    config_id: String,
    pty_manager: State<'_, ShellManager>,
) -> Result<(), String> {
    let _trace = crate::diagnostics::trace_command("run_process_stop");
    let session_id = run_session_id(&config_id);
    pty_manager.kill_session(&session_id);
    Ok(())
}
