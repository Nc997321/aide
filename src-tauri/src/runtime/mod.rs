use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{Mutex as TokioMutex, oneshot};
use tauri::{AppHandle, Emitter};
use serde_json::Value;
pub mod env;
pub mod provider;
use crate::runtime::provider::connection_fingerprint;

/// 进程内唯一即可：request id 不跨 Runtime 持久化，也不暴露给前端。
static NEXT_IMAGE_PROBE_REQUEST: AtomicU64 = AtomicU64::new(1);

/// 持久 Agent Runtime 管理器（替代 SidecarManager）。
///
/// 单一 `aide-agent.exe` 进程，内部按 session_id 多路复用多个 SessionWorker。
/// Rust 不再管理"每个会话一个进程"——只持有 Runtime 的 stdin / Child 句柄。
pub struct AgentRuntimeManager {
    stdin: Mutex<Option<Arc<TokioMutex<ChildStdin>>>>,
    child: Mutex<Option<Arc<TokioMutex<Child>>>>,
    killed: Arc<AtomicBool>,
    /// 每个 session 首次 spawn 时的连接身份指纹（base_url/api_key/auth_token/代理
    /// 子集）。跨 Runtime 重启持久——`kill_runtime` 不删它：后续 send_message 时拿它
    /// 跟当前 provider 配置比对，判断要不要 fork 绕开 CLI session 文件里缓存的旧
    /// provider 配置。
    fingerprints: Mutex<HashMap<String, BTreeMap<String, String>>>,
    /// Runtime 内部图片预检的临时应答表；结果不经过前端 chat-event。
    image_probe_waiters: Arc<Mutex<HashMap<String, oneshot::Sender<Option<bool>>>>>,
    /// 串行化冷启动，避免 setup 和首次预检各自 spawn 一个 Runtime。
    spawn_lock: TokioMutex<()>,
}

impl AgentRuntimeManager {
    pub fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            killed: Arc::new(AtomicBool::new(false)),
            fingerprints: Mutex::new(HashMap::new()),
            image_probe_waiters: Arc::new(Mutex::new(HashMap::new())),
            spawn_lock: TokioMutex::new(()),
        }
    }

    /// 幂等地启动 Runtime；应用冷启动与首个图片预检共享同一把启动锁。
    pub async fn ensure_runtime(
        &self,
        app_handle: AppHandle,
        env_vars: HashMap<String, String>,
    ) -> Result<(), String> {
        let _spawn_guard = self.spawn_lock.lock().await;
        if self.stdin.lock().unwrap().is_some() {
            return Ok(());
        }
        self.spawn_runtime(app_handle, env_vars)
    }

    /// App 启动时调用一次：启动 persistent aide-agent.exe 进程。
    /// 通过 `&self` + 内部 Mutex 实现，Tauri State 可共享访问。
    pub fn spawn_runtime(
        &self,
        app_handle: AppHandle,
        env_vars: HashMap<String, String>,
    ) -> Result<(), String> {
        let runtime_path = Self::resolve_runtime_path(&app_handle)?;
        // dev 模式：node runtime.js；release：直接跑 aide-agent.exe
        #[cfg(debug_assertions)]
        let (bin, arg) = {
            let node = std::env::var("AIDE_NODE_PATH").unwrap_or_else(|_| "node".to_string());
            (node, runtime_path)
        };
        #[cfg(not(debug_assertions))]
        let (bin, arg): (String, PathBuf) = {
            // release: aide-agent.exe 是独立可执行文件，不需要 node
            (runtime_path.to_string_lossy().to_string(), PathBuf::new())
        };

        let mut cmd = tokio::process::Command::new(&bin);
        #[cfg(not(debug_assertions))]
        { cmd.arg(&arg); }
        #[cfg(debug_assertions)]
        { cmd.arg(dunce::simplified(&arg)); }

        cmd.current_dir(std::env::current_dir().unwrap_or_default())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Git Bash PATH（Windows）
        #[cfg(windows)]
        {
            if let Some(path) = windows_path_with_git_usr_bin() {
                cmd.env("PATH", path);
            }
        }

        // 透传 provider 连接参数（由调用方 build_runtime_env_vars 组好传入）
        for (k, v) in &env_vars {
            cmd.env(k, v);
        }

        // CLAUDE_CONFIG_DIR：让 claude.exe 把所有自有数据（settings.json / CLAUDE.md /
        // agents/ / skills/ / projects/ / sessions/ / plugins/）写到 Aide 自管理目录
        // 下的 claude/ 子目录，而非回退到用户系统的 ~/.claude/。必须注在 env_vars 循环
        // 之后——build_runtime_env_vars 的 fallback 列表里也含 CLAUDE_CONFIG_DIR，若进程
        // env 有用户自定义值会被透传进 env_vars，这里显式覆盖以保证始终指向自管理目录。
        // 与 AIDE_ENABLED_PLUGINS_FILE 同属「Aide 自管理路径 env」，注在同一处。
        let claude_config_dir = crate::commands::our_config_dir().join("claude");
        cmd.env("CLAUDE_CONFIG_DIR", dunce::simplified(&claude_config_dir));

        // 插件桥接清单
        let manifest = crate::commands::marketplace::enabled_plugins_manifest_path();
        cmd.env("AIDE_ENABLED_PLUGINS_FILE", dunce::simplified(&manifest));

        // release：原生 CLI 随 app 分发
        #[cfg(not(debug_assertions))]
        {
            use tauri::Manager;
            if let Ok(res_dir) = app_handle.path().resource_dir() {
                let exe_name = if cfg!(windows) { "claude.exe" } else { "claude" };
                let claude_exe = res_dir.join("agent-runtime").join(exe_name);
                if claude_exe.exists() {
                    cmd.env("AIDE_CLAUDE_EXE", dunce::simplified(&claude_exe));
                }
            }
        }

        // dev：SDK 平台包里的 claude.exe 随 agent-sidecar 的 node_modules 安装。
        // 不设的话 SDK 会 `which claude` 回退到用户系统装的 CLI，违背「Aide 不依赖
        // 系统 Claude CLI」的目标。CARGO_MANIFEST_DIR 是 src-tauri/，向上出一层到
        // 项目根，再进 agent-sidecar/node_modules 找平台包。
        #[cfg(debug_assertions)]
        {
            let pkg = if cfg!(target_os = "windows") {
                "@anthropic-ai/claude-agent-sdk-win32-x64"
            } else if cfg!(target_os = "macos") {
                "@anthropic-ai/claude-agent-sdk-darwin-arm64"
            } else {
                "@anthropic-ai/claude-agent-sdk-linux-x64"
            };
            let exe_name = if cfg!(windows) { "claude.exe" } else { "claude" };
            let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("agent-sidecar")
                .join("node_modules")
                .join(pkg)
                .join(exe_name);
            if candidate.exists() {
                cmd.env("AIDE_CLAUDE_EXE", dunce::simplified(&candidate));
            }
        }

        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        let mut child = cmd.spawn().map_err(|e| format!(
            "无法启动 Agent Runtime（bin: {bin}）：{e}。"
        ))?;
        let stdin = child.stdin.take().ok_or("No stdin")?;
        let stdout = child.stdout.take().ok_or("No stdout")?;
        let stderr = child.stderr.take().ok_or("No stderr")?;

        *self.stdin.lock().unwrap() = Some(Arc::new(TokioMutex::new(stdin)));
        *self.child.lock().unwrap() = Some(Arc::new(TokioMutex::new(child)));

        // stdout reader 任务
        let app = app_handle.clone();
        let killed_clone = Arc::clone(&self.killed);
        let child_for_kill = self.child.lock().unwrap().as_ref().ok_or("child not set")?.clone();
        let image_probe_waiters = Arc::clone(&self.image_probe_waiters);

        // stderr 尾部缓冲
        let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        let tail_for_reader = Arc::clone(&stderr_tail);
        let tail_for_stderr = Arc::clone(&stderr_tail);

        tokio::spawn(async move {
            let stderr_tail = tail_for_reader;
            const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
            let mut reader = BufReader::new(stdout).lines();
            let reason: &str = loop {
                match tokio::time::timeout(HEARTBEAT_TIMEOUT, reader.next_line()).await {
                    Ok(Ok(Some(line))) => {
                        let Ok(mut event) = serde_json::from_str::<Value>(&line) else { continue };
                        // 图片预检是 Rust ↔ Runtime 的内部 request/response；不能转发给 Vue。
                        if event.get("type").and_then(|t| t.as_str()) == Some("image_input_probe_result") {
                            let Some(request_id) = event.get("request_id").and_then(|v| v.as_str()) else {
                                continue;
                            };
                            let supported = match event.get("supported") {
                                Some(Value::Bool(value)) => Some(*value),
                                Some(Value::Null) => None,
                                _ => continue,
                            };
                            if let Some(waiter) = image_probe_waiters.lock().unwrap().remove(request_id) {
                                let _ = waiter.send(supported);
                            }
                            continue;
                        }
                        // 心跳只喂看门狗，不转发前端
                        if event.get("type").and_then(|t| t.as_str()) == Some("heartbeat") {
                            continue;
                        }
                        // 诊断黑匣子：chat-event 出口按秒计量
                        {
                            use tauri::Manager;
                            if let Some(diag) =
                                app.try_state::<crate::diagnostics::DiagnosticsState>()
                            {
                                let event_type = event
                                    .get("type")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("unknown");
                                // session_init 事件的 session_id 是 SDK 真实会话 ID，
                                // 路由键在 _routing_id；其他事件的 session_id 即路由键。
                                let sid = event
                                    .get("_routing_id")
                                    .or_else(|| event.get("session_id"))
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("unknown");
                                diag.record_chat_event(sid, event_type, line.len() as u64);
                            }
                        }
                        // session_init 事件：SDK 的 session_id 是真实会话 ID，
                        // _routing_id 是 SessionManager 的路由键（临时 key）。
                        // 还原旧行为：session_id = 路由键（前端路由），sdk_session_id = 真 ID。
                        if let Some(obj) = event.as_object_mut() {
                            if obj.get("type").and_then(|t| t.as_str()) == Some("session_init") {
                                if let Some(sdk_sid) = obj.get("session_id").cloned() {
                                    obj.insert("sdk_session_id".to_string(), sdk_sid);
                                }
                                if let Some(routing_id) = obj.get("_routing_id").cloned() {
                                    obj.insert("session_id".to_string(), routing_id);
                                }
                            }
                        }
                        crate::diagnostics::trace::record(
                            "emit",
                            event.get("type").and_then(|t| t.as_str()).unwrap_or("unknown"),
                            "worker",
                        );
                        let _ = app.emit("chat-event", event);
                    }
                    Ok(Ok(None)) | Ok(Err(_)) => break "exit",
                    Err(_) => break "heartbeat_timeout",
                }
            };

            if reason == "heartbeat_timeout" {
                emit_runtime_dead(&app, &stderr_tail, reason);
                killed_clone.store(true, Ordering::Relaxed);
                let mut c = child_for_kill.lock().await;
                let _ = c.start_kill();
            } else if !killed_clone.load(Ordering::Relaxed) {
                emit_runtime_dead(&app, &stderr_tail, reason);
            }
        });

        // stderr 只进日志与尾部缓冲
        let tail_writer = tail_for_stderr;
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                if line.is_empty() { continue; }
                eprintln!("[runtime stderr] {}", line);
                let mut buf = tail_writer.lock().unwrap();
                if buf.len() >= 8 { buf.pop_front(); }
                buf.push_back(line);
            }
        });

        Ok(())
    }

    /// 所有命令写同一个 stdin（已带 session_id 字段，Runtime 内部路由）。
    pub async fn send_to_runtime(&self, cmd: &Value) -> Result<(), String> {
        let stdin = {
            let guard = self.stdin.lock().unwrap();
            guard.as_ref().ok_or("Runtime not spawned")?.clone()
        };
        let mut line = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut guard = stdin.lock().await;
        guard.write_all(line.as_bytes()).await.map_err(|e| e.to_string())
    }

    /// 请求 Runtime 用内置 1×1 PNG 预检当前连接/模型的图片能力。
    /// 无结论、Runtime 写入失败或超时都按未知处理，不能影响聊天会话。
    pub async fn probe_image_input(
        &self,
        env_vars: HashMap<String, String>,
    ) -> Result<Option<bool>, String> {
        let request_id = format!(
            "image-probe-{}",
            NEXT_IMAGE_PROBE_REQUEST.fetch_add(1, Ordering::Relaxed),
        );
        let (sender, receiver) = oneshot::channel();
        self.image_probe_waiters
            .lock()
            .unwrap()
            .insert(request_id.clone(), sender);

        let waiter_id = request_id.clone();
        let command = serde_json::json!({
            "cmd": "probe_image_input",
            "request_id": request_id,
            "model": env_vars.get("ANTHROPIC_MODEL"),
            "env": env_vars,
        });
        if self.send_to_runtime(&command).await.is_err() {
            self.image_probe_waiters.lock().unwrap().remove(&waiter_id);
            return Ok(None);
        }

        match tokio::time::timeout(Duration::from_secs(10), receiver).await {
            Ok(Ok(supported)) => Ok(supported),
            Ok(Err(_)) | Err(_) => {
                self.image_probe_waiters.lock().unwrap().remove(&waiter_id);
                Ok(None)
            }
        }
    }

    /// 杀死 Runtime 进程（全局 stop / app 退出）。
    #[allow(dead_code)]
    pub async fn kill_runtime(&self) {
        self.killed.store(true, Ordering::Relaxed);
        let child = {
            self.child.lock().unwrap().clone()
        };
        if let Some(child_arc) = child {
            let mut c = child_arc.lock().await;
            let _ = c.start_kill();
        }
    }

    /// 连接身份漂移检测：仅在新 session send 前调用。
    /// 持久化指纹存在且与当前 env 不一致 → true（需要 forkSession）。
    pub fn connection_drifted(
        &self,
        session_id: &str,
        env_vars: &HashMap<String, String>,
    ) -> bool {
        let fps = self.fingerprints.lock().unwrap();
        match fps.get(session_id) {
            None => false,
            Some(old) => *old != connection_fingerprint(env_vars),
        }
    }

    /// 记录/更新一个 session 的连接身份指纹（首次 send 时调用）。
    pub fn upsert_fingerprint(&self, session_id: &str, env_vars: &HashMap<String, String>) {
        self.fingerprints
            .lock()
            .unwrap()
            .insert(session_id.to_string(), connection_fingerprint(env_vars));
    }

    // ---- 路径解析 ----

    fn resolve_runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
        #[cfg(debug_assertions)]
        {
            let _ = app;
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            // dev: 跑 esbuild bundle 产物，用 node 启动
            let path = manifest.parent().unwrap()
                .join("agent-sidecar").join("dist").join("runtime.js");
            if path.exists() {
                return Ok(path);
            }
            return Err(format!(
                "Runtime not found at {:?}. Run: cd agent-sidecar && pnpm build",
                path
            ));
        }
        #[cfg(not(debug_assertions))]
        {
            use tauri::Manager;
            let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
            let path = resource_dir.join("agent-runtime").join("aide-agent.exe");
            if path.exists() {
                return Ok(dunce::simplified(&path).to_path_buf());
            }
            // fallback: 旧资源路径
            let fallback = resource_dir.join("agent-sidecar").join("aide-agent.exe");
            if fallback.exists() {
                return Ok(dunce::simplified(&fallback).to_path_buf());
            }
            Err(format!("Runtime exe missing: {:?}", path))
        }
    }
}

fn emit_runtime_dead(
    app: &AppHandle,
    tail_handle: &Arc<Mutex<VecDeque<String>>>,
    reason: &str,
) {
    let tail: Vec<String> = tail_handle.lock().unwrap().iter().cloned().collect();
    let detail = if tail.is_empty() { None } else { Some(tail.join("\n")) };
    crate::diagnostics::trace::record("runtime", reason, "worker");
    let event = serde_json::json!({
        "type": "runtime_dead",
        "reason": reason,
        "detail": detail,
    });
    let _ = app.emit("chat-event", event);
}

#[cfg(windows)]
fn windows_path_with_git_usr_bin() -> Option<String> {
    let git_exe = which::which("git").ok()?;
    let git_cmd_dir = git_exe.parent()?;
    let git_root = git_cmd_dir.parent()?;
    let usr_bin = git_root.join("usr").join("bin");
    if !usr_bin.is_dir() { return None; }
    let current_path = std::env::var("PATH").unwrap_or_default();
    Some(prepend_path_entry(&current_path, &usr_bin.to_string_lossy()))
}

#[cfg(windows)]
fn prepend_path_entry(path: &str, extra: &str) -> String {
    if extra.is_empty() { return path.to_string(); }
    let already_present = path.split(';').any(|p| p.eq_ignore_ascii_case(extra));
    if already_present { path.to_string() }
    else if path.is_empty() { extra.to_string() }
    else { format!("{extra};{path}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn prepend_path_entry_adds_when_missing() {
        let result = prepend_path_entry("C:\\Windows;C:\\Windows\\System32", "C:\\Git\\usr\\bin");
        assert_eq!(result, "C:\\Git\\usr\\bin;C:\\Windows;C:\\Windows\\System32");
    }

    #[test]
    #[cfg(windows)]
    fn prepend_path_entry_skips_when_already_present() {
        let path = "C:\\Git\\usr\\bin;C:\\Windows";
        let result = prepend_path_entry(path, "C:\\Git\\usr\\bin");
        assert_eq!(result, path);
    }

    #[test]
    #[cfg(windows)]
    fn prepend_path_entry_is_case_insensitive() {
        let path = "c:\\git\\usr\\bin;C:\\Windows";
        let result = prepend_path_entry(path, "C:\\Git\\usr\\bin");
        assert_eq!(result, path);
    }

    #[test]
    #[cfg(windows)]
    fn prepend_path_entry_handles_empty_path() {
        let result = prepend_path_entry("", "C:\\Git\\usr\\bin");
        assert_eq!(result, "C:\\Git\\usr\\bin");
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn connection_drifted_false_for_brand_new_session() {
        let mgr = AgentRuntimeManager::new();
        let env_vars = env(&[("ANTHROPIC_BASE_URL", "https://api.anthropic.com")]);
        assert!(!mgr.connection_drifted("no-such-session", &env_vars));
    }

    #[test]
    fn connection_drifted_false_when_same_provider_resume() {
        let mgr = AgentRuntimeManager::new();
        let fp = connection_fingerprint(&env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
        ]));
        mgr.fingerprints.lock().unwrap().insert("s1".to_string(), fp);
        let desired = env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
            ("ANTHROPIC_MODEL", "claude-sonnet-5"),
        ]);
        assert!(!mgr.connection_drifted("s1", &desired));
    }

    #[test]
    fn connection_drifted_true_when_provider_switched() {
        let mgr = AgentRuntimeManager::new();
        let fp = connection_fingerprint(&env(&[
            ("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
            ("ANTHROPIC_API_KEY", "key-a"),
        ]));
        mgr.fingerprints.lock().unwrap().insert("s1".to_string(), fp);
        let desired = env(&[
            ("ANTHROPIC_BASE_URL", "https://provider-b.example.com"),
            ("ANTHROPIC_API_KEY", "key-b"),
        ]);
        assert!(mgr.connection_drifted("s1", &desired));
    }

    #[test]
    fn fingerprints_survive_runtime_kill() {
        let mgr = AgentRuntimeManager::new();
        let fp = connection_fingerprint(&env(&[("ANTHROPIC_BASE_URL", "https://api.anthropic.com")]));
        mgr.fingerprints.lock().unwrap().insert("s1".to_string(), fp.clone());
        assert!(mgr.fingerprints.lock().unwrap().contains_key("s1"));
        let desired = env(&[("ANTHROPIC_BASE_URL", "https://provider-b.example.com")]);
        assert!(mgr.connection_drifted("s1", &desired));
    }
}
