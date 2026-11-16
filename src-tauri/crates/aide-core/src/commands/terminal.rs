//! 终端命令：工作台终端（PTY shell）、运行配置进程、技能扫描。
//!
//! PTY 会话住在 [`Core::pty`]；输出由前端轮询 `poll_pty_output`，退出经事件 `pty-exit`。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;

use crate::registry::{blocking, Command as HostCommand};
use crate::skills::{SkillMeta, SkillRegistry};
use crate::{command, Core};

#[path = "terminal_suggestion.rs"]
mod suggestion;

pub static COMMANDS: &[HostCommand] = &[
    command!("pty_write", pty_write),
    command!("pty_suggest_command", suggestion::suggest),
    command!("pty_close_suggestions", suggestion::close),
    command!("pty_execute_suggestion", pty_execute_suggestion),
    command!("pty_resize", pty_resize),
    command!("pty_kill", pty_kill),
    command!("poll_pty_output", poll_pty_output),
    command!("pty_spawn_shell", pty_spawn_shell),
    command!("run_process_start", run_process_start),
    command!("run_process_stop", run_process_stop),
    command!("scan_plugin_skills", scan_plugin_skills),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyWriteArgs {
    session_id: String,
    data: String,
}

async fn pty_write(core: Arc<Core>, a: PtyWriteArgs) -> Result<(), String> {
    core.pty.write(&a.session_id, &a.data)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExecuteSuggestionArgs {
    session_id: String,
    command: String,
    bracketed_paste: bool,
    ssh_token: Option<String>,
}

async fn pty_execute_suggestion(core: Arc<Core>, a: PtyExecuteSuggestionArgs) -> Result<(), String> {
    let data = if let Some(token) = a.ssh_token {
        use base64::Engine;
        if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("SSH 会话标识无效".into());
        }
        let command = suggestion::validate_command(&a.command)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(command);
        let guarded = format!("__aide_ssh_execute {token} {encoded}");
        if a.bracketed_paste {
            format!("\x1b[200~{guarded}\x1b[201~\r")
        } else {
            format!("{guarded}\r")
        }
    } else {
        suggestion::execution_input(&a.command, a.bracketed_paste)?
    };
    core.pty.write_checked(&a.session_id, data)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyResizeArgs {
    session_id: String,
    rows: u16,
    cols: u16,
}

async fn pty_resize(core: Arc<Core>, a: PtyResizeArgs) -> Result<(), String> {
    core.pty.resize(&a.session_id, a.rows, a.cols)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdArgs {
    session_id: String,
}

async fn pty_kill(core: Arc<Core>, a: SessionIdArgs) -> Result<(), String> {
    blocking(move || {
        core.pty.kill_session(&a.session_id);
        Ok(())
    })
    .await
}

/// 取走会话累积的 PTY 输出。前端定时轮询而不是收推送事件，消费速率由它自己掌控。
async fn poll_pty_output(core: Arc<Core>, a: SessionIdArgs) -> Result<String, String> {
    core.pty.poll_output(&a.session_id)
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
        if let Ok(p) = which::which("pwsh") {
            return Ok(p.to_string_lossy().to_string());
        }
        if let Ok(p) = which::which("powershell") {
            return Ok(p.to_string_lossy().to_string());
        }
        return Err(
            "Shell not found: install PowerShell or set shell_path in settings".to_string(),
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(s) = std::env::var("SHELL") {
            if !s.is_empty() {
                return Ok(s);
            }
        }
        if let Ok(p) = which::which("bash") {
            return Ok(p.to_string_lossy().to_string());
        }
        if let Ok(p) = which::which("sh") {
            return Ok(p.to_string_lossy().to_string());
        }
        Err("Shell not found: set shell_path in settings".to_string())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnShellArgs {
    session_id: String,
    rows: u16,
    cols: u16,
    cwd: String,
    shell: String,
    input_token: Option<String>,
}

/// Spawn a general-purpose shell in a PTY (workbench terminal).
/// `shell` empty → OS default shell.
async fn pty_spawn_shell(core: Arc<Core>, a: PtySpawnShellArgs) -> Result<String, String> {
    blocking(move || {
        let events = core.events();
        let program = resolve_shell(&a.shell)?;
        core.pty.spawn_shell(
            &a.session_id,
            &program,
            a.input_token.as_deref(),
            &PathBuf::from(&a.cwd),
            a.rows,
            a.cols,
            events,
        )?;
        Ok(std::path::Path::new(&program)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&program)
            .to_owned())
    })
    .await
}

fn run_session_id(config_id: &str) -> String {
    format!("run__{}", config_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProcessStartArgs {
    config_id: String,
    cwd: String,
    command: String,
    env: BTreeMap<String, String>,
    rows: u16,
    cols: u16,
    #[serde(flatten)]
    task_env: super::run_configs::TaskEnvironment,
}

async fn run_process_start(core: Arc<Core>, a: RunProcessStartArgs) -> Result<String, String> {
    blocking(move || {
        let session_id = run_session_id(&a.config_id);
        let cwd = PathBuf::from(a.cwd);
        let env = super::run_configs::resolve_task_env(&cwd, &a.command, a.env, a.task_env)?;
        // rows/cols 由前端 fit 出 xterm 真实尺寸后传入——ConPTY 从第一帧起即与 xterm
        // 列宽一致，避免用固定 80 列 spawn 导致长行被提前 wrap 割裂（spawn→resize
        // 窗口期内的输出按错误列宽渲染会永久留在 buffer 里）。
        core.pty.spawn_run_command(
            &session_id,
            &cwd,
            &a.command,
            &env,
            a.rows,
            a.cols,
            core.events(),
        )?;
        Ok(session_id)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProcessStopArgs {
    config_id: String,
}

async fn run_process_stop(core: Arc<Core>, a: RunProcessStopArgs) -> Result<(), String> {
    blocking(move || {
        core.pty.kill_session(&run_session_id(&a.config_id));
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPluginSkillsArgs {
    #[serde(default)]
    provider: Option<String>,
    cwd: String,
}

async fn scan_plugin_skills(_core: Arc<Core>, a: ScanPluginSkillsArgs) -> Result<Vec<SkillMeta>, String> {
    blocking(move || Ok(SkillRegistry::new().list(a.provider.as_deref(), std::path::Path::new(&a.cwd)))).await
}
