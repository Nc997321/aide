use portable_pty::{PtySize, CommandBuilder, native_pty_system, MasterPty};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

struct PtySession {
    #[allow(dead_code)]
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
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
        // Kill existing PTY for this session if any
        self.kill_session(session_id);

        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

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

        let mut child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn {}: {}", command, e))?;

        drop(pty_pair.slave);

        let master = pty_pair.master;
        let writer = master.take_writer().map_err(|e| format!("Failed to take writer: {}", e))?;
        let mut reader = master.try_clone_reader().map_err(|e| format!("Failed to clone reader: {}", e))?;

        let output_buffer = Arc::new(Mutex::new(String::new()));

        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(
                session_id.to_string(),
                PtySession { master, writer, output_buffer: output_buffer.clone() },
            );
        }

        let sid = session_id.to_string();
        let sessions = self.sessions.clone();
        let app_waiter = app_handle.clone();

        // Reader thread — appends PTY output to a shared buffer.
        // The frontend polls this buffer via `poll_pty_output` command.
        // This pull-based design prevents IPC event flooding: the frontend
        // controls the data rate by polling at its own pace (every 100ms),
        // so the JS event loop is never overwhelmed regardless of output volume.
        let buf_for_reader = output_buffer.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]);
                        if let Ok(mut output) = buf_for_reader.lock() {
                            output.push_str(&data);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Waiter thread — blocks on child.wait() to reliably detect process exit
        let sid_waiter = sid.clone();
        thread::spawn(move || {
            let _ = child.wait();
            if let Ok(mut map) = sessions.lock() {
                map.remove(&sid_waiter);
            }
            let payload = serde_json::json!({ "session_id": &sid_waiter });
            let _ = app_waiter.emit("pty-exit", payload.to_string());
        });

        Ok(())
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
        // Kill existing PTY for this session if any
        self.kill_session(session_id);

        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        cmd.cwd(cwd);

        let mut child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;

        drop(pty_pair.slave);

        let master = pty_pair.master;
        let writer = master.take_writer().map_err(|e| format!("Failed to take writer: {}", e))?;
        let mut reader = master.try_clone_reader().map_err(|e| format!("Failed to clone reader: {}", e))?;

        let output_buffer = Arc::new(Mutex::new(String::new()));

        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(
                session_id.to_string(),
                PtySession { master, writer, output_buffer: output_buffer.clone() },
            );
        }

        let sid = session_id.to_string();
        let sessions = self.sessions.clone();
        let app_waiter = app_handle.clone();

        let buf_for_reader = output_buffer.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]);
                        if let Ok(mut output) = buf_for_reader.lock() {
                            output.push_str(&data);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let sid_waiter = sid.clone();
        thread::spawn(move || {
            let _ = child.wait();
            if let Ok(mut map) = sessions.lock() {
                map.remove(&sid_waiter);
            }
            let payload = serde_json::json!({ "session_id": &sid_waiter });
            let _ = app_waiter.emit("pty-exit", payload.to_string());
        });

        Ok(())
    }

    /// Resize the PTY for a specific session
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

    /// Write to the PTY for a specific session
    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get_mut(session_id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| format!("Write failed: {}", e))?;
            session.writer.flush().map_err(|e| format!("Flush failed: {}", e))?;
        }
        Ok(())
    }

    /// Kill a specific session's PTY
    pub fn kill_session(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
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
