use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// Per-session write-queue capacity. Bounded so a foreground process that
/// stops reading its stdin (hung / busy-loop) can neither grow memory without
/// bound nor block the caller — a full queue simply drops input.
const WRITE_QUEUE_CAP: usize = 256;

/// Shape of the `pty-exit` payload emitted when a session's child exits.
enum ExitPayload {
    /// `{"session_id": "..."}` — used by workbench-shell sessions.
    Plain,
    /// `{"session_id":"...","success":bool}` — used by run-config sessions,
    /// whose UI reports whether the command succeeded.
    Run,
}

struct ShellSession {
    master: Box<dyn MasterPty + Send>,
    /// Bounded sender into the session's writer thread. `shell_write` performs a
    /// non-blocking `try_send`, so a full queue (hung process) drops the input
    /// instead of stalling the Tauri main thread or the shared `sessions` mutex.
    writer_tx: SyncSender<String>,
    /// Cloned child-killer, split off before `child` moved into the waiter
    /// thread. Lets `kill_session` terminate the process from the main thread
    /// even while the waiter is blocked in `child.wait()`.
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    output_buffer: Arc<Mutex<String>>,
}

pub struct ShellManager {
    sessions: Arc<Mutex<HashMap<String, ShellSession>>>,
}

impl ShellManager {
    pub fn new() -> Self {
        ShellManager {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Common launch path shared by `spawn_shell` and `spawn_run_command`.
    /// Builds the PTY, spawns the child, and starts the three per-session
    /// worker threads (reader / writer / waiter).
    fn launch(
        &self,
        session_id: &str,
        cmd: CommandBuilder,
        label: &str,
        rows: u16,
        cols: u16,
        app_handle: AppHandle,
        payload_kind: ExitPayload,
    ) -> Result<(), String> {
        // Kill existing PTY for this session if any.
        self.kill_session(session_id);

        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn {}: {}", label, e))?;

        drop(pty_pair.slave);

        let killer = Arc::new(Mutex::new(child.clone_killer()));

        let master = pty_pair.master;
        let mut writer = master.take_writer().map_err(|e| format!("Failed to take writer: {}", e))?;
        let mut reader = master.try_clone_reader().map_err(|e| format!("Failed to clone reader: {}", e))?;

        let output_buffer = Arc::new(Mutex::new(String::new()));
        let (writer_tx, writer_rx) = mpsc::sync_channel::<String>(WRITE_QUEUE_CAP);

        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(
                session_id.to_string(),
                ShellSession {
                    master,
                    writer_tx,
                    killer: killer.clone(),
                    output_buffer: output_buffer.clone(),
                },
            );
        }

        // Reader thread — appends PTY output to a shared buffer the frontend
        // polls via `poll_pty_output`.
        let buf_for_reader = output_buffer.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]);
                        if let Ok(mut output) = buf_for_reader.lock() {
                            output.push_str(&data);
                        }
                    }
                }
            }
        });

        // Writer thread — owns the PTY writer and drains the bounded queue.
        thread::spawn(move || {
            while let Ok(data) = writer_rx.recv() {
                if writer.write_all(data.as_bytes()).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });

        // Waiter thread — blocking `wait()` for instant, reliable exit detection.
        let sessions = self.sessions.clone();
        let sid = session_id.to_string();
        let app_waiter = app_handle;
        thread::spawn(move || {
            let mut child = child;
            let success = child.wait().ok().map(|s| s.success()).unwrap_or(false);

            if let Ok(mut map) = sessions.lock() {
                map.remove(&sid);
            }
            let payload = match payload_kind {
                ExitPayload::Plain => serde_json::json!({ "session_id": &sid }).to_string(),
                ExitPayload::Run => {
                    serde_json::json!({ "session_id": &sid, "success": success }).to_string()
                }
            };
            let _ = app_waiter.emit("pty-exit", payload);
        });

        Ok(())
    }

    /// Spawn an arbitrary shell program in a PTY (for the workbench terminal).
    /// `program` must already be a resolved path (e.g. from `which`).
    pub fn spawn_shell(
        &self,
        session_id: &str,
        program: &str,
        args: &[&str],
        cwd: &PathBuf,
        rows: u16,
        cols: u16,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.cwd(cwd);

        self.launch(session_id, cmd, program, rows, cols, app_handle, ExitPayload::Plain)
    }

    /// Spawn a user run-config command in a PTY via the system shell.
    /// On Windows: `cmd /c <command>`. On Unix: `sh -c <command>`.
    /// The waiter thread emits `pty-exit` with `{"session_id":"...","success":bool}`.
    ///
    /// `env`：注入子进程的环境变量（覆盖继承的系统值）。目前用于按项目选 JDK：
    /// 含 `JAVA_HOME` 时自动把 `<JAVA_HOME>/bin` 前置到 `PATH`，让裸 `java -jar`
    /// 和 `mvn`（mvn.cmd 用 JAVA_HOME 找 java）都解析到该 JDK；若 env 已显式带
    /// `PATH` 则不干预，尊重调用方。无 env 时子进程原样继承系统环境（旧行为）。
    pub fn spawn_run_command(
        &self,
        session_id: &str,
        cwd: &PathBuf,
        command: &str,
        env: &BTreeMap<String, String>,
        rows: u16,
        cols: u16,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        let (shell_bin, shell_args): (String, Vec<String>) = (
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            // chcp 65001：与工作台终端同一 UTF-8 方案（见 commands/shell.rs
            // utf8_console_args），防中文机器 GBK 代码页下运行输出乱码。
            // `&` 连接不影响最终退出码（取最后一条命令的）。
            vec!["/c".into(), format!("chcp 65001 >nul & {}", command)],
        );
        #[cfg(not(target_os = "windows"))]
        let (shell_bin, shell_args): (String, Vec<String>) = (
            "/bin/sh".into(),
            vec!["-c".into(), command.into()],
        );

        let mut cmd = CommandBuilder::new(&shell_bin);
        cmd.args(&shell_args);
        cmd.cwd(cwd);

        for (k, v) in env {
            cmd.env(k, v);
        }
        if !env.contains_key("PATH") {
            if let Some(jh) = env.get("JAVA_HOME").filter(|s| !s.is_empty()) {
                let sep = if cfg!(windows) { ";" } else { ":" };
                let cur_path = std::env::var("PATH").unwrap_or_default();
                let new_path = prepend_java_bin_to_path(jh, &cur_path, sep);
                cmd.env("PATH", new_path);
            }
        }

        self.launch(session_id, cmd, command, rows, cols, app_handle, ExitPayload::Run)
    }

    /// Resize the PTY for a specific session.
    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get(session_id) {
            session
                .master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("Resize failed: {}", e))?;
        }
        Ok(())
    }

    /// Write to the PTY for a specific session (non-blocking).
    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let tx = {
            let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            match sessions.get(session_id) {
                Some(session) => session.writer_tx.clone(),
                None => return Ok(()), // session already gone — ignore silently
            }
        };
        let _ = tx.try_send(data.to_string());
        Ok(())
    }

    /// Kill a specific session's PTY.
    pub fn kill_session(&self, session_id: &str) {
        let session = {
            let mut sessions = match self.sessions.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            sessions.remove(session_id)
        };
        if let Some(session) = session {
            if let Ok(mut killer) = session.killer.lock() {
                let _ = killer.kill();
            }
        }
    }

    /// Drain accumulated PTY output for a session.
    /// Returns the buffered data and clears the buffer.
    pub fn poll_output(&self, session_id: &str) -> Result<String, String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get(session_id) {
            let mut output = session.output_buffer.lock().map_err(|e| e.to_string())?;
            let data = std::mem::take(&mut *output);
            Ok(data)
        } else {
            Ok(String::new())
        }
    }
}

/// 把 `<java_home>/bin` 前置到现有 `PATH`，使子进程解析 `java`/`mvn` 等命令时
/// 优先命中该 JDK 的可执行文件。纯函数（无 IO），便于单测。
/// `sep` 是平台路径分隔符：Windows `;`、Unix `:`。
pub(crate) fn prepend_java_bin_to_path(java_home: &str, cur_path: &str, sep: &str) -> String {
    let bin = PathBuf::from(java_home).join("bin");
    match cur_path.is_empty() {
        false => format!("{}{}{}", bin.display(), sep, cur_path),
        true => bin.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepend_java_bin_to_path_windows_sep() {
        // 用 PathBuf 计算期望值，使断言与平台实际分隔符一致（Windows `\`）
        let bin = PathBuf::from("C:\\jdks\\jdk-21").join("bin");
        let expected = format!("{};{}", bin.display(), "C:\\Windows;C:\\other");
        assert_eq!(prepend_java_bin_to_path("C:\\jdks\\jdk-21", "C:\\Windows;C:\\other", ";"), expected);
    }

    #[test]
    fn prepend_java_bin_to_path_unix_sep() {
        let bin = PathBuf::from("/jdks/jdk-21").join("bin");
        let expected = format!("{}:{}", bin.display(), "/usr/bin:/bin");
        assert_eq!(prepend_java_bin_to_path("/jdks/jdk-21", "/usr/bin:/bin", ":"), expected);
    }

    #[test]
    fn prepend_java_bin_to_path_empty_current() {
        // 空现有 PATH 时不能留尾随分隔符
        let bin = PathBuf::from("/jdks/jdk-8").join("bin");
        assert_eq!(prepend_java_bin_to_path("/jdks/jdk-8", "", ":"), bin.display().to_string());
    }
}
