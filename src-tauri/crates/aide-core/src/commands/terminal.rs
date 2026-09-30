//! 终端命令：工作台终端（PTY shell）、运行配置进程、技能扫描。
//!
//! PTY 会话住在 [`Core::pty`]；输出由前端轮询 `poll_pty_output`，退出经事件 `pty-exit`。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use serde::Deserialize;

use crate::registry::{blocking, Command as HostCommand};
use crate::skills::{SkillMeta, SkillRegistry};
use crate::{command, Core};

pub static COMMANDS: &[HostCommand] = &[
    command!("pty_write", pty_write),
    command!("pty_resize", pty_resize),
    command!("pty_kill", pty_kill),
    command!("poll_pty_output", poll_pty_output),
    command!("pty_spawn_shell", pty_spawn_shell),
    command!("run_process_start", run_process_start),
    command!("run_process_stop", run_process_stop),
    command!("scan_plugin_skills", scan_plugin_skills),
];

/// 过渡期（P1 前）的远程工作区终端：cwd 是远程路径时返回 `(argv, 本机 cwd)`，
/// 由宿主改为在 PTY 里跑 `wsl.exe …` / `ssh -t …`。P1（窗口连 Host）后终端本来就开在
/// Host 上，这个钩子随逐命令路由一起删除。
pub type RemoteShell = fn(&str) -> Option<Result<(Vec<String>, PathBuf), String>>;

static REMOTE_SHELL: OnceLock<RemoteShell> = OnceLock::new();

/// 启动时调一次（第二次调用被忽略）。
pub fn set_remote_shell(hook: RemoteShell) {
    let _ = REMOTE_SHELL.set(hook);
}

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnShellArgs {
    session_id: String,
    rows: u16,
    cols: u16,
    cwd: String,
    shell: String,
}

/// Spawn a general-purpose shell in a PTY (workbench terminal).
/// `shell` empty → OS default shell.
async fn pty_spawn_shell(core: Arc<Core>, a: PtySpawnShellArgs) -> Result<(), String> {
    blocking(move || {
        let events = core.events();
        if let Some(remote) = REMOTE_SHELL.get().and_then(|hook| hook(&a.cwd)) {
            let (argv, local_cwd) = remote?;
            let args: Vec<&str> = argv[1..].iter().map(|s| s.as_str()).collect();
            return core.pty.spawn_shell(
                &a.session_id,
                &argv[0],
                &args,
                &local_cwd,
                a.rows,
                a.cols,
                events,
            );
        }
        let program = resolve_shell(&a.shell)?;
        #[cfg(target_os = "windows")]
        let args = utf8_console_args(&program);
        #[cfg(not(target_os = "windows"))]
        let args: Vec<String> = Vec::new();
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        core.pty.spawn_shell(
            &a.session_id,
            &program,
            &arg_refs,
            &PathBuf::from(&a.cwd),
            a.rows,
            a.cols,
            events,
        )
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
}

async fn run_process_start(core: Arc<Core>, a: RunProcessStartArgs) -> Result<String, String> {
    blocking(move || {
        let session_id = run_session_id(&a.config_id);
        // rows/cols 由前端 fit 出 xterm 真实尺寸后传入——ConPTY 从第一帧起即与 xterm
        // 列宽一致，避免用固定 80 列 spawn 导致长行被提前 wrap 割裂（spawn→resize
        // 窗口期内的输出按错误列宽渲染会永久留在 buffer 里）。
        core.pty.spawn_run_command(
            &session_id,
            &PathBuf::from(&a.cwd),
            &a.command,
            &a.env,
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
