use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex as TokioMutex;
use tauri::{AppHandle, Emitter};
use serde_json::Value;


struct SidecarSession {
    stdin: Arc<TokioMutex<ChildStdin>>,
    /// Arc 化：reader 看门狗任务与 kill() 都需要收割进程，共享同一句柄。
    child: Arc<TokioMutex<Child>>,
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
        let sidecar_js = Self::resolve_sidecar_path(&app_handle)?;
        let node_bin = std::env::var("AIDE_NODE_PATH").unwrap_or_else(|_| "node".to_string());

        let mut cmd = tokio::process::Command::new(&node_bin);
        cmd.arg(&sidecar_js)
            .current_dir(&cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // claude.exe 内部给 Bash 工具 spawn 的 Git Bash 是非交互式启动
        // （`bash -c "command"`），不会 source shell profile；Git for Windows
        // 默认只把 `Git\cmd` 写进持久化的系统/用户 PATH，真正装 ls/grep/cat 等
        // coreutils 的 `Git\usr\bin` 只在交互式终端会话里被它自己的 profile
        // 脚本临时加上。旧版走 xterm/PTY 起交互式终端时这个缺口被盖住了；现在
        // sidecar 是 Node 子进程直接管道通信，没有终端层兜底，PATH 完全靠
        // 继承，必须显式把 usr\bin 塞进去，不能赌用户机器的持久化 PATH 配置对。
        #[cfg(windows)]
        {
            if let Some(path) = windows_path_with_git_usr_bin() {
                cmd.env("PATH", path);
            }
        }

        for (k, v) in &env_vars {
            cmd.env(k, v);
        }

        // release：原生 CLI 随 app 分发在资源目录，路径通过环境变量传给 sidecar
        // （SDK options.pathToClaudeCodeExecutable）；dev 模式由 SDK 从
        // agent-sidecar/node_modules 自行解析，不设该变量。
        #[cfg(not(debug_assertions))]
        {
            use tauri::Manager;
            if let Ok(res_dir) = app_handle.path().resource_dir() {
                let exe_name = if cfg!(windows) { "claude.exe" } else { "claude" };
                let claude_exe = res_dir.join("agent-sidecar").join(exe_name);
                if claude_exe.exists() {
                    // 同 sidecar.js：SDK 会把这个路径 spawn 成子进程，同样要剥掉
                    // Windows `\\?\` 前缀，否则原生 CLI 启动时会踩同一个坑。
                    cmd.env("AIDE_CLAUDE_EXE", dunce::simplified(&claude_exe));
                }
            }
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
        let child = Arc::new(TokioMutex::new(child));

        let killed = Arc::new(AtomicBool::new(false));
        let sid_shared = Arc::new(Mutex::new(session_id.clone()));
        // stderr 尾部缓冲（最多 8 行）：意外退出时拼进 error 事件用于诊断
        let stderr_tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

        let sid_handle = Arc::clone(&sid_shared);
        let tail_handle = Arc::clone(&stderr_tail);
        let app = app_handle.clone();
        let killed_clone = Arc::clone(&killed);
        let child_for_kill = Arc::clone(&child);
        tokio::spawn(async move {
            // 心跳看门狗：sidecar 每 5s 发一行（含心跳），任意行在 15s 内到达即证明
            // 进程存活；连续 15s 无任何行 = 事件循环卡死/进程失联 → 判死。
            const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
            let mut reader = BufReader::new(stdout).lines();
            let reason: &str = loop {
                match tokio::time::timeout(HEARTBEAT_TIMEOUT, reader.next_line()).await {
                    Ok(Ok(Some(line))) => {
                        let Ok(mut event) = serde_json::from_str::<Value>(&line) else { continue };
                        // 心跳只用来喂看门狗（收到即已重置 timeout），不转发前端避免刷屏。
                        if event.get("type").and_then(|t| t.as_str()) == Some("heartbeat") {
                            continue;
                        }
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
                    Ok(Ok(None)) | Ok(Err(_)) => break "exit", // EOF / 读错误：进程已退出
                    Err(_) => break "heartbeat_timeout",       // 15s 无任何行：卡死/失联
                }
            };

            // 两条判死路径统一只发一次 session_dead：
            // - 看门狗超时：先上报，再收割僵尸进程（EOF 路径进程已死，无需收割）；
            //   随后置 killed 抑制可能的 EOF 二次上报。
            // - 意外退出：仅当非用户主动 kill 时上报（主动 kill 已置 killed，保持静默）。
            if reason == "heartbeat_timeout" {
                emit_session_dead(&app, &sid_handle, &tail_handle, reason);
                killed_clone.store(true, Ordering::Relaxed);
                let mut c = child_for_kill.lock().await;
                let _ = c.start_kill();
            } else if !killed_clone.load(Ordering::Relaxed) {
                emit_session_dead(&app, &sid_handle, &tail_handle, reason);
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

    pub async fn kill(&self, session_id: &str) {
        // 先从注册表摘除并在锁外收割：std::Mutex 不可跨 await 持有。
        let removed = self.sessions.lock().unwrap().remove(session_id);
        if let Some(s) = removed {
            // 先置 killed 再杀：reader 随后的 EOF 会因 killed=true 而不再上报
            // session_dead（用户主动停止不是意外死亡）。
            s.killed.store(true, Ordering::Relaxed);
            let mut child = s.child.lock().await;
            let _ = child.start_kill();
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

    fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
        #[cfg(debug_assertions)]
        {
            let _ = app;
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
            use tauri::Manager;
            let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
            let path = resource_dir.join("agent-sidecar").join("sidecar.js");
            if path.exists() {
                // resource_dir() 在 Windows 上带 `\\?\` verbatim 前缀；node 拿它当入口
                // 脚本时 realpathSync 处理不了该前缀会 `lstat 'C:'` 崩在 run_main。
                // simplified() 在能安全去前缀时去掉（非 Windows 为 no-op）。
                return Ok(dunce::simplified(&path).to_path_buf());
            }
            Err(format!("Sidecar resource missing: {:?}", path))
        }
    }
}

/// 合成并发出 session_dead 事件——统一 reader EOF 与看门狗超时两条判死路径的上报
/// 格式。session_id 现取自共享句柄（rename 后即为新 id）；detail 携带 stderr 尾部
/// 用于诊断，无尾部时为 null。
fn emit_session_dead(
    app: &AppHandle,
    sid_handle: &Arc<Mutex<String>>,
    tail_handle: &Arc<Mutex<VecDeque<String>>>,
    reason: &str,
) {
    let current_sid = sid_handle.lock().unwrap().clone();
    let tail: Vec<String> = tail_handle.lock().unwrap().iter().cloned().collect();
    let detail = if tail.is_empty() { None } else { Some(tail.join("\n")) };
    let event = serde_json::json!({
        "type": "session_dead",
        "reason": reason,
        "detail": detail,
        "session_id": current_sid,
    });
    let _ = app.emit("chat-event", event);
}

/// 用现有 PATH 里能找到的 `git.exe` 定位 Git for Windows 安装根目录，
/// 拼出装 ls/grep/cat 等 coreutils 的 `usr\bin` 子目录。找不到 git 或者
/// 目录不存在时返回 `None`——这种情况下不去动 PATH，交给继承的原样传递。
#[cfg(windows)]
fn windows_path_with_git_usr_bin() -> Option<String> {
    let git_exe = which::which("git").ok()?;
    let git_cmd_dir = git_exe.parent()?; // .../Git/cmd
    let git_root = git_cmd_dir.parent()?; // .../Git
    let usr_bin = git_root.join("usr").join("bin");
    if !usr_bin.is_dir() {
        return None;
    }
    let current_path = std::env::var("PATH").unwrap_or_default();
    Some(prepend_path_entry(&current_path, &usr_bin.to_string_lossy()))
}

/// 把 `extra` 前置进 Windows PATH（`;` 分隔），已存在则原样返回。
/// 提成纯函数方便测试，不依赖真实文件系统/环境变量。
#[cfg(windows)]
fn prepend_path_entry(path: &str, extra: &str) -> String {
    if extra.is_empty() {
        return path.to_string();
    }
    let already_present = path.split(';').any(|p| p.eq_ignore_ascii_case(extra));
    if already_present {
        path.to_string()
    } else if path.is_empty() {
        extra.to_string()
    } else {
        format!("{extra};{path}")
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn prepend_path_entry_adds_when_missing() {
        let result = prepend_path_entry("C:\\Windows;C:\\Windows\\System32", "C:\\Git\\usr\\bin");
        assert_eq!(result, "C:\\Git\\usr\\bin;C:\\Windows;C:\\Windows\\System32");
    }

    #[test]
    fn prepend_path_entry_skips_when_already_present() {
        let path = "C:\\Git\\usr\\bin;C:\\Windows";
        let result = prepend_path_entry(path, "C:\\Git\\usr\\bin");
        assert_eq!(result, path);
    }

    #[test]
    fn prepend_path_entry_is_case_insensitive() {
        // Windows 路径大小写不敏感——同一目录不该因为大小写不同被当成"缺失"重复加。
        let path = "c:\\git\\usr\\bin;C:\\Windows";
        let result = prepend_path_entry(path, "C:\\Git\\usr\\bin");
        assert_eq!(result, path);
    }

    #[test]
    fn prepend_path_entry_handles_empty_path() {
        let result = prepend_path_entry("", "C:\\Git\\usr\\bin");
        assert_eq!(result, "C:\\Git\\usr\\bin");
    }
}
