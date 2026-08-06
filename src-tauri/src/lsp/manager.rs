use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use crate::ignore_dirs::ALWAYS_IGNORE_DIRS;
use crate::lsp::detector::LanguageId;
use crate::lsp::docs::OpenDocs;
use crate::lsp::registry::{self, ServerSource};
use crate::lsp::rpc::{dispatch, Action, Router};
use crate::lsp::transport::LspTransport;

// ── EnsureError ──

#[derive(Debug)]
pub enum EnsureError {
    ServerNotFound,
    SpawnFailed(String),
    HandshakeFailed(String),
}

// ── 超时预算（全链有界：任何一步挂起都不无限等，失败路径杀进程防孤儿）──
/// spawn_lock 获取：持锁者被卡住（spawn 慢/挂起）时队列不无限等待。
const SPAWN_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// init_handshake 的 send：与 rx 的 5s 对齐（send 卡 pipe 时也要有界）。
const HANDSHAKE_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

// ── ServerHandle ──

pub struct ServerHandle {
    pub transport: LspTransport,
    pub docs: Arc<TokioMutex<OpenDocs>>,
    pub router: Arc<Router>,
    pub exclude_globs: Vec<String>,
    pub initialized: AtomicBool,
    pub dead: Arc<AtomicBool>,
    _child: Option<Arc<TokioMutex<tokio::process::Child>>>,
}

impl ServerHandle {
    pub fn is_alive(&self) -> bool {
        !self.dead.load(Ordering::Relaxed) && self.initialized.load(Ordering::Relaxed)
    }
}

// ── LspManager ──

/// key = (workspace_root_string, LanguageId)
pub struct LspManager {
    handles: TokioMutex<HashMap<(String, LanguageId), Arc<ServerHandle>>>,
    spawn_lock: TokioMutex<()>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            handles: TokioMutex::new(HashMap::new()),
            spawn_lock: TokioMutex::new(()),
        }
    }

    /// 幂等：已 alive 直接返；dead → 重拉。全链有界：拿锁 30s 超时（持锁者
    /// 被 spawn 卡住时队列不无限等），spawn 30s、握手 send/rx 各 5s，失败杀进程。
    pub async fn ensure_server(
        &self,
        workspace: &str,
        lang: LanguageId,
        app: &tauri::AppHandle,
        settings: &crate::commands::settings::AppSettings,
    ) -> Result<Arc<ServerHandle>, EnsureError> {
        let _g = tokio::time::timeout(SPAWN_LOCK_TIMEOUT, self.spawn_lock.lock())
            .await
            .map_err(|_| EnsureError::SpawnFailed("spawn_lock timeout (holder stuck >30s)".into()))?;
        {
            let map = self.handles.lock().await;
            if let Some(h) = map.get(&(workspace.to_string(), lang)) {
                if h.is_alive() {
                    return Ok(Arc::clone(h));
                }
            }
        }
        // dead 或不存在 → spawn 新的
        let src = registry::resolve(lang, settings, app).ok_or(EnsureError::ServerNotFound)?;
        let handle = spawn_and_init(workspace, lang, &src, app, settings).await?;
        self.handles
            .lock()
            .await
            .insert((workspace.to_string(), lang), Arc::clone(&handle));
        Ok(handle)
    }

    pub async fn kill_workspace(&self, workspace: &str) {
        let removed: Vec<Arc<ServerHandle>> = {
            let mut map = self.handles.lock().await;
            let keys: Vec<_> = map
                .keys()
                .filter(|(w, _)| w == workspace)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|k| map.remove(&k))
                .collect()
        };
        for h in removed {
            shutdown_handle(&h).await;
        }
    }

    pub async fn kill_server(&self, workspace: &str, lang: LanguageId) {
        let removed = self
            .handles
            .lock()
            .await
            .remove(&(workspace.to_string(), lang));
        if let Some(h) = removed {
            shutdown_handle(&h).await;
        }
    }

    /// 排除集变更后重拉该工作区全部 server（init exclude 不支持热改）。
    pub async fn restart_workspace(
        &self,
        workspace: &str,
        _app: &tauri::AppHandle,
        _settings: &crate::commands::settings::AppSettings,
    ) -> Result<(), EnsureError> {
        self.kill_workspace(workspace).await;
        // 重新 ensure 各 lang（调用方已知该工作区活跃 lang；这里由 mod.rs 逐个 did_open 时自然重拉）
        Ok(())
    }

    pub async fn get(
        &self,
        workspace: &str,
        lang: LanguageId,
    ) -> Option<Arc<ServerHandle>> {
        self.handles
            .lock()
            .await
            .get(&(workspace.to_string(), lang))
            .filter(|h| h.is_alive())
            .cloned()
    }
}

// ── 排除集 ──

/// 排除集 = ALWAYS_IGNORE_DIRS ∪ workspace.lsp_exclude_dirs，转 `**/{dir}/**` globs。
pub fn build_exclude_globs(workspace_exclude_dirs: &[String]) -> Vec<String> {
    let mut globs: Vec<String> = ALWAYS_IGNORE_DIRS
        .iter()
        .map(|d| format!("**/{d}/**"))
        .collect();
    for d in workspace_exclude_dirs {
        // 用户给的是相对工作区根的目录名/路径，取末段做 glob（IDEA 式 mark directory as excluded）
        let seg = d
            .split(|c| c == '/' || c == '\\')
            .filter(|s| !s.is_empty())
            .last()
            .unwrap_or(d);
        globs.push(format!("**/{seg}/**"));
    }
    globs
}

/// 路径是否落在排除集（didOpen 前置过滤）。path 用正斜杠。
pub fn is_excluded(path: &str, exclude_globs: &[String]) -> bool {
    let norm = path.replace('\\', "/");
    for g in exclude_globs {
        // glob `**/{dir}/**` → 路径含 /dir/ 即命中（简单 substring；v1 不引 glob 库）
        if let Some(dir) = g.strip_prefix("**/").and_then(|s| s.strip_suffix("/**")) {
            if norm.contains(&format!("/{dir}/")) {
                return true;
            }
        }
    }
    false
}

// ── shutdown_handle ──

async fn shutdown_handle(h: &ServerHandle) {
    // 发 shutdown request → exit notification → 标 dead
    let (msg, id, tx, _rx) = h.router.next_request("shutdown", serde_json::Value::Null);
    h.transport.table.lock().await.insert(id, tx);
    let _ = h.transport.send(&msg).await;
    // 不等响应（grace period），直接 exit + 标 dead
    let exit = serde_json::json!({"jsonrpc":"2.0","method":"exit"});
    let _ = h.transport.send(&exit).await;
    h.dead.store(true, Ordering::Relaxed);
    h.transport.table.lock().await.reject_all();
    // 兜底：exit 通知后给 3s 让进程自己退出；没退就强杀——否则 server 卡住时
    // 进程残留（JVM 内存不归还 OS，Task Manager 里 java.exe 不消失）。
    if let Some(child) = &h._child {
        let mut c = child.lock().await;
        let exited = matches!(
            tokio::time::timeout(std::time::Duration::from_secs(3), c.wait()).await,
            Ok(Ok(_))
        );
        if !exited {
            let _ = c.kill().await;
            let _ = c.wait().await;
        }
    }
}

// ── spawn_and_init ──

#[allow(unused_variables)]
async fn spawn_and_init(
    workspace: &str,
    lang: LanguageId,
    src: &ServerSource,
    app: &tauri::AppHandle,
    settings: &crate::commands::settings::AppSettings,
) -> Result<Arc<ServerHandle>, EnsureError> {
    let exclude_dirs = crate::commands::workspace::lsp_workspace_config(
        &crate::commands::workspace::path_to_key(workspace),
    )
    .exclude_dirs;
    let exclude_globs = build_exclude_globs(&exclude_dirs);

    // —— 生产 spawn ——
    #[cfg(not(test))]
    let (transport, child, stderr_lines) = spawn_real(workspace, lang, src, app).await?;
    #[cfg(test)]
    let (transport, child, stderr_lines) = spawn_test(workspace, lang, src).await;

    let router = Arc::new(Router::new());
    let docs = Arc::new(TokioMutex::new(OpenDocs::new()));
    let dead = Arc::new(AtomicBool::new(false));
    let initialized = AtomicBool::new(false);

    let handle = Arc::new(ServerHandle {
        transport,
        docs,
        router: Arc::clone(&router),
        exclude_globs: exclude_globs.clone(),
        initialized,
        dead: Arc::clone(&dead),
        _child: child,
    });

    // —— reader 任务 ——
    start_reader(handle.clone(), app.clone());

    // —— initialize 握手 ——
    if let Err(e) = init_handshake(&handle, workspace, lang, &exclude_globs).await {
        // 给 stderr reader 一点时间 flush：子进程退出 → pipe 关闭 → reader 读最后几行。
        // 50ms 对用户无感（握手本身已耗时数秒），比 oneshot 信号简单可靠。
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let stderr_summary = stderr_lines.lock().await.join("\n");
        // stderr 非空 → 拼进错误消息（rustup proxy "Unknown binary..." 这类关键线索得以回传前端 + 日志）
        let enhanced = match e {
            EnsureError::HandshakeFailed(msg) if !stderr_summary.is_empty() => {
                EnsureError::HandshakeFailed(format!("{msg}; stderr:\n{stderr_summary}"))
            }
            other => other,
        };
        tracing::warn!(
            "[lsp] handshake failed: lang={}, workspace={}, err={:?}",
            lang.id_str(),
            workspace,
            enhanced
        );
        // 握手失败/超时：显式杀子进程，防孤儿堆积（否则每次重探又 spawn 一个新进程，
        // 系统上堆满不响应 initialize 的 server，越用越慢——"探测中永不结束"的放大器）。
        if let Some(child) = &handle._child {
            let mut c = child.lock().await;
            let _ = c.kill().await;
            let _ = c.wait().await;
        }
        return Err(enhanced);
    }
    handle.initialized.store(true, Ordering::Relaxed);
    Ok(handle)
}

// ── spawn_real（生产）──

/// 按 profile 给定的路径建 data 目录。位置由 profile.data_dir_path 自决——
/// 默认 <workspace>/.aide/<name>（工作区内），jdtls 覆写移到工作区外（见
/// profiles/java.rs：Eclipse 拒绝项目包含自己的 data 目录）。manager 不掺语言特有逻辑。
async fn ensure_data_dir(path: std::path::PathBuf) -> Result<std::path::PathBuf, EnsureError> {
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| EnsureError::SpawnFailed(format!("create data dir {}: {e}", path.display())))?;
    Ok(path)
}

/// 组 spawn 命令。Windows 上 .bat/.cmd 不能直接 CreateProcess（实测报"找不到文件"/
/// 错误 193），必须 `cmd /C` 包装——覆盖 Which（完整路径含扩展名）与用户 Explicit 配 .bat。
#[cfg(windows)]
fn build_spawn_command(program: &std::path::Path, args: &[String]) -> tokio::process::Command {
    use tokio::process::Command;
    let lower = program.to_string_lossy().to_lowercase();
    if lower.ends_with(".bat") || lower.ends_with(".cmd") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(program).args(args);
        c
    } else {
        let mut c = Command::new(program);
        c.args(args);
        c
    }
}

#[cfg(not(windows))]
fn build_spawn_command(program: &std::path::Path, args: &[String]) -> tokio::process::Command {
    use tokio::process::Command;
    let mut c = Command::new(program);
    c.args(args);
    c
}

#[cfg(not(test))]
async fn spawn_real(
    workspace: &str,
    lang: LanguageId,
    src: &ServerSource,
    app: &tauri::AppHandle,
) -> Result<(LspTransport, Option<Arc<TokioMutex<tokio::process::Child>>>, Arc<TokioMutex<Vec<String>>>), EnsureError> {
    use tauri::Manager;

    // stderr 环形缓冲（上限 20 行）：reader 任务写入，握手失败时回读拼进错误消息。
    // 解决"server 启动失败但用户看不到原因"——stderr 走 tracing 进日志，同时留最近若干行
    // 供 spawn_and_init 在 channel closed 时拼出"rustup proxy 报 Unknown binary..."这类关键线索。
    let stderr_lines: Arc<TokioMutex<Vec<String>>> = Arc::new(TokioMutex::new(Vec::new()));

    // 隔离数据目录由 profile.data_dir_path 自决位置（默认 <workspace>/.aide/<name>，
    // jdtls 覆写移到工作区外），manager 只负责按此路径建目录。
    let config_dir = crate::commands::our_config_dir();
    let data_dir = match crate::lsp::profiles::profile(lang).data_dir_path(workspace, &config_dir) {
        Some(path) => Some(ensure_data_dir(path).await?),
        None => None,
    };
    let (program, args) = registry::to_command(lang, src, data_dir.as_deref());
    // Bundled：拼完整资源路径 + dunce 剥前缀
    let program_path = match src {
        ServerSource::Bundled { subdir, binary } => {
            let res_dir = app
                .path()
                .resource_dir()
                .map_err(|e| EnsureError::SpawnFailed(e.to_string()))?;
            let p = res_dir.join("lsp").join(subdir).join(binary);
            dunce::simplified(&p).to_path_buf()
        }
        _ => std::path::PathBuf::from(&program),
    };
    let mut cmd = build_spawn_command(&program_path, &args);
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(std::env::current_dir().unwrap_or_default());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    } // CREATE_NO_WINDOW
    // tokio 1.52 的 Command::spawn 是同步返回（非 async）：CreateProcess 即使被杀软
    // 扫描卡住也最终返回，天然有界——只占 worker 线程（"慢"）不会无限挂起（"挂"）。
    // 真正的无限挂起点是 async 链（spawn_lock / send / rx），已由超时覆盖。
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("{:?}: {}", program_path, e);
            tracing::warn!(
                "[lsp] spawn failed: lang={}, workspace={}, program={:?}, err={}",
                lang.id_str(),
                workspace,
                program_path,
                e
            );
            return Err(EnsureError::SpawnFailed(msg));
        }
    };
    let stdin = child
        .stdin
        .take()
        .ok_or(EnsureError::SpawnFailed("no stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(EnsureError::SpawnFailed("no stdout".into()))?;
    // stderr 尾部缓冲：读行 → tracing 进日志 + 环形缓冲（握手失败时回读），防 pipe buffer 阻塞
    if let Some(stderr) = child.stderr.take() {
        let stderr_buf = Arc::clone(&stderr_lines);
        let lang_id = lang.id_str();
        tokio::spawn(async move {
            use tokio::io::BufReader;
            use tokio::io::AsyncBufReadExt;
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!("[lsp stderr] [{}] {}", lang_id, line);
                let mut buf = stderr_buf.lock().await;
                buf.push(line);
                if buf.len() > 20 {
                    buf.remove(0);
                }
            }
        });
    }
    let child = Arc::new(TokioMutex::new(child));
    let transport = LspTransport::with_reader_source(Box::new(stdin), Box::new(stdout));
    Ok((transport, Some(child), stderr_lines))
}

// ── spawn_test（mock）──

#[cfg(test)]
async fn spawn_test(
    _workspace: &str,
    _lang: LanguageId,
    _src: &ServerSource,
) -> (LspTransport, Option<Arc<TokioMutex<tokio::process::Child>>>, Arc<TokioMutex<Vec<String>>>) {
    let mock = crate::lsp::mock_server::spawn_mock_lsp();
    let transport =
        LspTransport::with_reader_source(mock.transport_stdin, mock.transport_stdout);
    (transport, None, Arc::new(TokioMutex::new(Vec::new())))
}

// ── start_reader ──

fn start_reader(handle: Arc<ServerHandle>, app: tauri::AppHandle) {
    use tauri::Emitter;
    use tokio::io::{AsyncReadExt, BufReader};

    let table = handle.transport.table_handle();
    let dead = Arc::clone(&handle.dead);
    tokio::spawn(async move {
        let reader_source = handle.transport.take_reader_source().await;
        let mut reader = BufReader::new(reader_source);
        let mut framer = crate::lsp::transport::Framer::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            for msg in framer.feed(&buf[..n]) {
                match dispatch(&msg) {
                    Action::ResolveWaiter { id, result } => {
                        if let Some(tx) = table.lock().await.take(id) {
                            let _ = tx.send(result);
                        }
                    }
                    Action::EmitDiagnostics {
                        uri,
                        diagnostics,
                        version,
                    } => {
                        let _ = app.emit(
                            "lsp-diagnostics",
                            serde_json::json!({
                                "workspaceRoot": "",
                                "uri": uri,
                                "diagnostics": diagnostics,
                                "version": version
                            }),
                        );
                    }
                    Action::Log(s) => tracing::info!("[lsp] {}", s),
                    Action::ShowMessage(s) => {
                        let _ = app.emit("lsp-show-message", s);
                    }
                    Action::ServerRequest {
                        id,
                        method: _,
                        params: _,
                    } => {
                        // v1：回空 response（不实现 workspace/configuration 等细节）
                        tracing::debug!("[lsp] server request ignored: id={:?}", id);
                    }
                    Action::Ignore => {}
                }
            }
        }
        // EOF：reject 所有 waiter + 标 dead
        table.lock().await.reject_all();
        dead.store(true, Ordering::Relaxed);
        let _ = app.emit("lsp-server-dead", ());
    });
}

// ── init_handshake ──

async fn init_handshake(
    handle: &ServerHandle,
    workspace: &str,
    lang: LanguageId,
    exclude_globs: &[String],
) -> Result<(), EnsureError> {
    let root_uri = crate::lsp::protocol::path_to_uri(workspace);
    // 初始化选项按语言档案注入（Rust excludeGlobs / Go directoryFilters / 其余默认）
    let init_options = crate::lsp::profiles::profile(lang).init_options(&exclude_globs);
    // 注意：capabilities 只声明规范允许的字段——`workspace.workspaceEdit` 的类型是
    // 对象（WorkspaceEditClientCapabilities），传布尔会炸 jdtls 的 Gson 严格解析
    // （实测 error -32700 → ClientPreferences 永不设置 → 后续诊断/补全全 NPE）。
    let params = serde_json::json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "capabilities": {
            "textDocument": {"synchronization": {"didSave": false}}
        },
        "workspaceFolders": [{"uri": root_uri, "name": workspace}],
        "initializationOptions": init_options,
    });
    let (msg, id, tx, rx) = handle.router.next_request("initialize", params);
    handle.transport.table.lock().await.insert(id, tx);
    // send 也带超时（pipe 写阻塞时不无限挂起）
    tokio::time::timeout(HANDSHAKE_SEND_TIMEOUT, handle.transport.send(&msg))
        .await
        .map_err(|_| EnsureError::HandshakeFailed("send initialize timeout (>5s)".into()))?
        .map_err(|e| EnsureError::HandshakeFailed(e.to_string()))?;
    // 握手判活超时按语言档案（Java 30s：jdtls 首次启动 OSGi + 索引 10-30s；其余 5s）
    let handshake_timeout = crate::lsp::profiles::profile(lang).handshake_timeout();
    let result = match tokio::time::timeout(handshake_timeout, rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => {
            return Err(EnsureError::HandshakeFailed("channel closed".into()))
        }
        Err(_) => {
            return Err(EnsureError::HandshakeFailed(
                "initialize timeout (>5s, no capabilities)".into(),
            ))
        }
    };
    // 校验响应是 result 而非 error——server 侧解析/处理失败时（如 jdtls 对非法
    // capabilities 报 -32700）必须判握手失败，否则面板假 ✓ 而后续请求全挂。
    if let Some(err) = result.get("error") {
        let msg = err["message"].as_str().unwrap_or("initialize error");
        return Err(EnsureError::HandshakeFailed(format!(
            "initialize rejected: {msg}"
        )));
    }
    // initialized notification
    let initd = serde_json::json!({"jsonrpc":"2.0","method":"initialized","params":{}});
    handle
        .transport
        .send(&initd)
        .await
        .map_err(|e| EnsureError::HandshakeFailed(e.to_string()))?;
    Ok(())
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_globs_union_with_workspace_excludes() {
        let globs = build_exclude_globs(&vec!["generated".into(), "vendor".into()]);
        // 硬编码黑名单
        assert!(globs.contains(&"**/node_modules/**".to_string()));
        assert!(globs.contains(&"**/target/**".to_string()));
        // 用户手动排除
        assert!(globs.contains(&"**/generated/**".to_string()));
        assert!(globs.contains(&"**/vendor/**".to_string()));
    }

    #[test]
    fn exclude_globs_format() {
        let g = build_exclude_globs(&[])[0].clone();
        assert!(g.starts_with("**/") && g.ends_with("/**"), "{}", g);
    }

    #[test]
    fn exclude_globs_takes_last_path_segment() {
        // 用户给 "src/generated" → glob 用末段 "generated"
        let globs = build_exclude_globs(&vec!["src/generated".into()]);
        assert!(globs.contains(&"**/generated/**".to_string()));
        assert!(!globs.contains(&"**/src/generated/**".to_string()));
    }

    #[test]
    fn is_excluded_matches_dir() {
        let globs = build_exclude_globs(&vec!["generated".into()]);
        assert!(is_excluded("C:/proj/generated/x.rs", &globs));
        assert!(is_excluded("C:/proj/sub/generated/y.ts", &globs));
        assert!(!is_excluded("C:/proj/src/main.rs", &globs));
    }

    #[test]
    fn is_excluded_normalizes_backslash() {
        let globs = build_exclude_globs(&vec!["target".into()]);
        assert!(is_excluded("C:\\proj\\target\\x.rs", &globs));
    }

    #[test]
    fn always_ignore_dirs_unchanged_after_extract() {
        // 回归：抽取后黑名单仍含核心项（与 walk.rs 共享同一常量）
        assert!(ALWAYS_IGNORE_DIRS.contains(&"node_modules"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&"target"));
        assert!(ALWAYS_IGNORE_DIRS.contains(&".git"));
    }

}
