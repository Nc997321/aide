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

/// Windows 终端 UTF-8 启动参数（与 sidecar winBashEnv 同一思路：chcp 65001）。
/// ConPTY 按控制台代码页解释子进程写出的原始字节——中文机器默认 GBK(936)，
/// 输出 UTF-8 的工具（git/node 等）会被误解码成全角乱码；启动时把代码页切到
/// 65001 后 ConPTY 按 UTF-8 解释，乱码消失。按 shell 类型给对应启动参数；
/// 不认识的 shell（如用户自配的 bash）返回空、不干预。
#[cfg(target_os = "windows")]
fn utf8_console_args(program: &str) -> Vec<String> {
    let name = std::path::Path::new(program)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match name.as_str() {
        "powershell.exe" | "pwsh.exe" => vec![
            "-NoExit".into(),
            "-Command".into(),
            "chcp 65001 >$null".into(),
        ],
        "cmd.exe" => vec!["/k".into(), "chcp 65001 >nul".into()],
        _ => Vec::new(),
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
    let _trace = crate::diagnostics::trace_command("pty_spawn_shell");
    let program = resolve_shell(&shell)?;
    #[cfg(target_os = "windows")]
    let args = utf8_console_args(&program);
    #[cfg(not(target_os = "windows"))]
    let args: Vec<String> = Vec::new();
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let cwd_path = PathBuf::from(&cwd);
    manager.spawn_shell(&session_id, &program, &arg_refs, &cwd_path, rows, cols, app_handle)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::utf8_console_args;

    #[test]
    fn powershell_gets_noexit_chcp() {
        for p in [
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        ] {
            let args = utf8_console_args(p);
            assert_eq!(args.len(), 3);
            assert_eq!(args[0], "-NoExit");
            assert_eq!(args[1], "-Command");
            assert!(args[2].contains("chcp 65001"));
        }
    }

    #[test]
    fn cmd_gets_k_chcp() {
        let args = utf8_console_args("C:\\Windows\\System32\\cmd.exe");
        assert_eq!(args, vec!["/k".to_string(), "chcp 65001 >nul".to_string()]);
    }

    #[test]
    fn unknown_shell_untouched() {
        assert!(utf8_console_args("C:\\Program Files\\Git\\bin\\bash.exe").is_empty());
    }
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
