use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
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
    /// `{"session_id": "..."}` — used by Claude and workbench-shell sessions.
    Plain,
    /// `{"session_id":"...","success":bool}` — used by run-config sessions,
    /// whose UI reports whether the command succeeded.
    Run,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Bounded sender into the session's writer thread. `pty_write` performs a
    /// non-blocking `try_send`, so a full queue (hung process) drops the input
    /// instead of stalling the Tauri main thread or the shared `sessions` mutex.
    writer_tx: SyncSender<String>,
    /// Cloned child-killer, split off before `child` moved into the waiter
    /// thread. Lets `kill_session` terminate the process from the main thread
    /// even while the waiter is blocked in `child.wait()`.
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    output_buffer: Arc<Mutex<String>>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Common launch path shared by `spawn_command`, `spawn_shell`, and
    /// `spawn_run_command`. Builds the PTY, spawns the child, and starts the
    /// three per-session worker threads (reader / writer / waiter).
    ///
    /// The writer thread is the crux of the "hung process can't freeze the
    /// app" fix: `write_all` + `flush` run on a worker thread that holds no
    /// locks, so a wedged foreground process stalls only that one session's
    /// queue — never the Tauri main thread and never the shared `sessions`
    /// mutex (which would otherwise freeze every other terminal too).
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

        // Split off a killer BEFORE `child` moves into the waiter thread, so
        // `kill_session` can signal the process from the main thread while the
        // waiter is blocked in `wait()`. This is the portable_pty-blessed way
        // to kill a child whose owner thread is stuck in a blocking wait.
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
                PtySession {
                    master,
                    writer_tx,
                    killer: killer.clone(),
                    output_buffer: output_buffer.clone(),
                },
            );
        }

        // Reader thread — appends PTY output to a shared buffer the frontend
        // polls via `poll_pty_output`. Pull-based so the JS event loop controls
        // the data rate and is never flooded regardless of output volume.
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
        // This is what keeps a hung foreground process from freezing the app:
        // blocking `write_all`/`flush` happen here, on a worker thread holding
        // no locks — never on the Tauri main thread and never under the shared
        // `sessions` mutex.
        thread::spawn(move || {
            while let Ok(data) = writer_rx.recv() {
                if writer.write_all(data.as_bytes()).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });

        // Waiter thread — blocking `wait()` for instant, reliable exit
        // detection. Safe to block here: it owns `child` and holds no lock
        // during the wait. `kill_session` signals the child via the cloned
        // killer, which both unblocks `wait()` (process terminated) and the
        // writer thread's stalled `write_all` (input pipe torn down).
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

    /// Spawn a command in a PTY, scoped to a session_id.
    /// If a PTY already exists for this session_id, it is killed first.
    pub fn spawn_command(
        &self,
        session_id: &str,
        command: &str,
        args: &[&str],
        cwd: &PathBuf,
        rows: u16,
        cols: u16,
        env_vars: HashMap<String, String>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        // On Windows, npm global packages are .cmd wrappers (the bare name
        // resolves to a shell script, not a valid Win32 exe — error 193).
        #[cfg(target_os = "windows")]
        let resolved = format!("{}.cmd", command);
        #[cfg(not(target_os = "windows"))]
        let resolved = command.to_string();

        let mut cmd = CommandBuilder::new(&resolved);
        cmd.args(args);
        cmd.cwd(cwd);
        for (key, value) in &env_vars {
            cmd.env(key, value);
        }

        self.launch(session_id, cmd, command, rows, cols, app_handle, ExitPayload::Plain)
    }

    /// Spawn an arbitrary shell program in a PTY (for the workbench terminal).
    /// Unlike `spawn_command`, this does NOT append `.cmd` on Windows —
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
    pub fn spawn_run_command(
        &self,
        session_id: &str,
        cwd: &PathBuf,
        command: &str,
        rows: u16,
        cols: u16,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        let (shell_bin, shell_args): (String, Vec<String>) = (
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            vec!["/c".into(), command.into()],
        );
        #[cfg(not(target_os = "windows"))]
        let (shell_bin, shell_args): (String, Vec<String>) = (
            "/bin/sh".into(),
            vec!["-c".into(), command.into()],
        );

        let mut cmd = CommandBuilder::new(&shell_bin);
        cmd.args(&shell_args);
        cmd.cwd(cwd);

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

    /// Write to the PTY for a specific session.
    ///
    /// Non-blocking by design: it clones the bounded sender under a brief lock
    /// (released before any IO), then `try_send`s. If the process isn't
    /// consuming stdin (hung), the queue is full and the input is dropped
    /// rather than blocking the caller — this is what prevents a wedged
    /// foreground process from stalling the Tauri main thread or any other
    /// session.
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
    ///
    /// Actually terminates the child process — closing the ConPty master does
    /// NOT kill the process on Windows, so without an explicit `kill()` a hung
    /// process would outlive the session, leaking the waiter thread (blocked in
    /// `wait()`) and the writer thread (blocked in `write_all`). The cloned
    /// killer signals the child, which unblocks both threads; dropping the
    /// session then closes the master (unblocking the reader) and the sender
    /// (letting the writer thread finish).
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
            // `session` drops here: master closed (reader unblocks), writer_tx
            // dropped (writer thread drains then exits once the killed child
            // tears down the input pipe). The waiter thread's `wait()` returns
            // because the child was killed; it no-ops its map remove and emits
            // `pty-exit`.
        }
    }

    /// Re-key a session's PTY (used when "new_xxx" → real UUID)
    pub fn rename_session(&self, old_id: &str, new_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.remove(old_id) {
                sessions.insert(new_id.to_string(), session);
            }
        }
    }

    /// Check if a session has a live PTY
    pub fn has_session(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|s| s.contains_key(session_id))
            .unwrap_or(false)
    }

    /// Drain accumulated PTY output for a session.
    /// Returns the buffered data and clears the buffer.
    /// The frontend calls this on a polling interval instead of receiving
    /// push events, giving it full control over the data consumption rate.
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