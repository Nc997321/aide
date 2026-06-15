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
        app_handle: AppHandle,
    ) -> Result<(), String> {
        // Kill existing PTY for this session if any
        self.kill_session(session_id);

        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);
        cmd.cwd(cwd);

        let _child = pty_pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn {}: {}", command, e))?;

        drop(pty_pair.slave);

        let master = pty_pair.master;
        let writer = master.take_writer().map_err(|e| format!("Failed to take writer: {}", e))?;
        let mut reader = master.try_clone_reader().map_err(|e| format!("Failed to clone reader: {}", e))?;

        {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions.insert(
                session_id.to_string(),
                PtySession { master, writer },
            );
        }

        let sid = session_id.to_string();

        // Reader thread — emits session-scoped pty-output
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let payload = serde_json::json!({
                            "session_id": sid,
                            "data": data,
                        });
                        let _ = app_handle.emit("pty-output", payload.to_string());
                    }
                    Err(_) => break,
                }
            }
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
}
