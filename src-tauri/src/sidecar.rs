use std::collections::{HashMap, VecDeque};
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
    /// 会话 ID 共享句柄：rename 后 reader 任务发出的事件立刻携带新 ID
    sid: Arc<Mutex<String>>,
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

        let mut child = cmd.spawn().map_err(|e| format!(
            "无法启动 agent sidecar（node: {node_bin}）：{e}。请确认已安装 Node.js ≥ 18 并在 PATH 中，或设置 AIDE_NODE_PATH 环境变量指向 node 可执行文件。"
        ))?;
        let stdin = Arc::new(TokioMutex::new(
            child.stdin.take().ok_or("No stdin")?,
        ));
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;

        let killed = Arc::new(AtomicBool::new(false));
        let sid_shared = Arc::new(Mutex::new(session_id.clone()));
        // stderr 尾部缓冲（最多 8 行）：意外退出时拼进 error 事件用于诊断
        let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

        let sid_handle = Arc::clone(&sid_shared);
        let tail_handle = Arc::clone(&stderr_tail);
        let app = app_handle.clone();
        let killed_clone = Arc::clone(&killed);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if let Ok(mut event) = serde_json::from_str::<Value>(&line) {
                    let current_sid = sid_handle.lock().unwrap().clone();
                    if let Some(obj) = event.as_object_mut() {
                        if obj.get("type").and_then(|t| t.as_str()) == Some("session_init") {
                            if let Some(sdk_sid) = obj.get("session_id").cloned() {
                                obj.insert("sdk_session_id".to_string(), sdk_sid);
                            }
                        }
                        obj.insert("session_id".to_string(), Value::String(current_sid));
                    }
                    let _ = app.emit("chat-event", event);
                }
            }
            // 只有非主动 kill 才通知前端解除 isBusy
            if !killed_clone.load(Ordering::Relaxed) {
                let current_sid = sid_handle.lock().unwrap().clone();
                let tail: Vec<String> = tail_handle.lock().unwrap().iter().cloned().collect();
                let detail = if tail.is_empty() {
                    String::new()
                } else {
                    format!("\n{}", tail.join("\n"))
                };
                let exit_event = serde_json::json!({
                    "type": "error",
                    "message": format!("Sidecar process exited unexpectedly{detail}"),
                    "session_id": current_sid
                });
                let _ = app.emit("chat-event", exit_event);
            }
        });

        // stderr 只进日志与尾部缓冲，不作为 error 事件发给前端
        // （Node 的 warning / SDK 诊断输出不该打断会话，见 CLAUDE.md「stderr 不是错误」）
        let tail_writer = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.is_empty() { continue; }
                eprintln!("[sidecar stderr] {}", line);
                let mut buf = tail_writer.lock().unwrap();
                if buf.len() >= 8 { buf.pop_front(); }
                buf.push_back(line);
            }
        });

        self.sessions.lock().unwrap().insert(
            session_id,
            SidecarSession { stdin, child, killed, sid: sid_shared },
        );
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

    /// 把运行中会话从 old_id 重命名为 new_id：重挂 HashMap key 并更新共享 sid，
    /// 之后 reader 任务发出的事件立即携带新 ID。old 不存在时静默成功（幂等）。
    pub fn rename(&self, old_id: &str, new_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(old_id) {
            *session.sid.lock().unwrap() = new_id.to_string();
            sessions.insert(new_id.to_string(), session);
        }
        Ok(())
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
