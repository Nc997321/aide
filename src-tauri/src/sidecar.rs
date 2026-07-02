use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as TokioMutex;
use tauri::{AppHandle, Emitter};
use serde_json::Value;


struct SidecarSession {
    stdin: Arc<TokioMutex<ChildStdin>>,
    child: Child,
    killed: Arc<AtomicBool>,
}

pub struct SidecarManager {
    sessions: Mutex<HashMap<String, SidecarSession>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }

    pub fn spawn(
        &self,
        session_id: String,
        cwd: PathBuf,
        env_vars: HashMap<String, String>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let sidecar_js = Self::resolve_sidecar_path()?;
        let node_bin = std::env::var("AIDE_NODE_PATH").unwrap_or_else(|_| "node".to_string());

        let mut cmd = tokio::process::Command::new(&node_bin);
        cmd.arg(&sidecar_js)
            .current_dir(&cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (k, v) in &env_vars {
            cmd.env(k, v);
        }

        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn sidecar: {e}"))?;
        let stdin = Arc::new(TokioMutex::new(
            child.stdin.take().ok_or("No stdin")?,
        ));
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;

        let killed = Arc::new(AtomicBool::new(false));

        let sid = session_id.clone();
        let app = app_handle.clone();
        let killed_clone = Arc::clone(&killed);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Ok(mut event) = serde_json::from_str::<Value>(&line) {
                    if let Some(obj) = event.as_object_mut() {
                        if obj.get("type").and_then(|t| t.as_str()) == Some("session_init") {
                            if let Some(sdk_sid) = obj.get("session_id").cloned() {
                                obj.insert("sdk_session_id".to_string(), sdk_sid);
                            }
                        }
                        obj.insert("session_id".to_string(), Value::String(sid.clone()));
                    }
                    let _ = app.emit("chat-event", event);
                }
            }
            // 只有非主动 kill 才通知前端解除 isBusy
            if !killed_clone.load(Ordering::Relaxed) {
                let exit_event = serde_json::json!({
                    "type": "error",
                    "message": "Sidecar process exited unexpectedly",
                    "session_id": sid
                });
                let _ = app.emit("chat-event", exit_event);
            }
        });

        let sid2 = session_id.clone();
        let app2 = app_handle.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.is_empty() { continue; }
                eprintln!("[sidecar stderr] {}", line);
                if line.starts_with("[sidecar]") { continue; }
                let event = serde_json::json!({
                    "type": "error",
                    "message": line,
                    "session_id": sid2
                });
                let _ = app2.emit("chat-event", event);
            }
        });

        self.sessions.lock().unwrap().insert(session_id, SidecarSession { stdin, child, killed });
        Ok(())
    }

    pub async fn send(&self, session_id: &str, cmd: &Value) -> Result<(), String> {
        let stdin = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions.get(session_id)
                .ok_or_else(|| format!("Session not found: {session_id}"))?;
            Arc::clone(&session.stdin)
        }; // Mutex lock released here before await
        let mut line = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut guard = stdin.lock().await;
        guard.write_all(line.as_bytes()).await.map_err(|e| e.to_string())
    }

    pub fn kill(&self, session_id: &str) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(session_id) {
            s.killed.store(true, Ordering::Relaxed);
            let _ = s.child.start_kill();
        }
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_id)
    }

    fn resolve_sidecar_path() -> Result<PathBuf, String> {
        #[cfg(debug_assertions)]
        {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let path = manifest.parent().unwrap().join("agent-sidecar/dist/sidecar.js");
            if path.exists() {
                return Ok(path);
            }
            return Err(format!(
                "Sidecar not found at {:?}. Run: cd agent-sidecar && npm run build",
                path
            ));
        }
        #[cfg(not(debug_assertions))]
        {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            Ok(exe.parent().unwrap().join("agent-sidecar.js"))
        }
    }
}
