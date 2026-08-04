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

    /// 幂等：已 alive 直接返；dead → 重拉。
    pub async fn ensure_server(
        &self,
        workspace: &str,
        lang: LanguageId,
        app: &tauri::AppHandle,
        settings: &crate::commands::settings::AppSettings,
    ) -> Result<Arc<ServerHandle>, EnsureError> {
        let _g = self.spawn_lock.lock().await;
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
    // 发 shutdown request → 给 500ms grace → exit notification → 标 dead
    let (msg, id, tx, _rx) = h.router.next_request("shutdown", serde_json::Value::Null);
    h.transport.table.lock().await.insert(id, tx);
    let _ = h.transport.send(&msg).await;
    // 不等响应（grace period），直接 exit + 标 dead
    let exit = serde_json::json!({"jsonrpc":"2.0","method":"exit"});
    let _ = h.transport.send(&exit).await;
    h.dead.store(true, Ordering::Relaxed);
    h.transport.table.lock().await.reject_all();
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
    let (transport, child) = spawn_real(src, app).await?;
    #[cfg(test)]
    let (transport, child) = spawn_test(src).await;

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
    init_handshake(&handle, workspace, lang, &exclude_globs).await?;
    handle.initialized.store(true, Ordering::Relaxed);
    Ok(handle)
}

// ── spawn_real（生产）──

#[cfg(not(test))]
async fn spawn_real(
    src: &ServerSource,
    app: &tauri::AppHandle,
) -> Result<(LspTransport, Option<Arc<TokioMutex<tokio::process::Child>>>), EnsureError> {
    use tauri::Manager;
    use tokio::process::Command;

    let (program, args) = registry::to_command(src);
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
    let mut cmd = Command::new(&program_path);
    cmd.args(&args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(std::env::current_dir().unwrap_or_default());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    } // CREATE_NO_WINDOW
    let mut child = cmd
        .spawn()
        .map_err(|e| EnsureError::SpawnFailed(format!("{:?}: {}", program_path, e)))?;
    let stdin = child
        .stdin
        .take()
        .ok_or(EnsureError::SpawnFailed("no stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(EnsureError::SpawnFailed("no stdout".into()))?;
    // stderr 尾部缓冲：读行并日志，防 pipe buffer 阻塞
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::BufReader;
            use tokio::io::AsyncBufReadExt;
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[lsp stderr] {line}");
            }
        });
    }
    let child = Arc::new(TokioMutex::new(child));
    let transport = LspTransport::with_reader_source(Box::new(stdin), Box::new(stdout));
    Ok((transport, Some(child)))
}

// ── spawn_test（mock）──

#[cfg(test)]
async fn spawn_test(
    _src: &ServerSource,
) -> (LspTransport, Option<Arc<TokioMutex<tokio::process::Child>>>) {
    let mock = crate::lsp::mock_server::spawn_mock_lsp();
    let transport =
        LspTransport::with_reader_source(mock.transport_stdin, mock.transport_stdout);
    (transport, None)
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
    // 按语言注入 init exclude（rust-analyzer: excludeGlobs；gopls: directoryFilters）
    let init_options = match lang {
        LanguageId::Rust => serde_json::json!({"excludeGlobs": exclude_globs}),
        LanguageId::Go => serde_json::json!({
            "directoryFilters": exclude_globs
                .iter()
                .map(|g| g.replace("**/", "-").replace("/**", ""))
                .collect::<Vec<_>>()
        }),
        _ => serde_json::json!({}),
    };
    let params = serde_json::json!({
        "processId": std::process::id(),
        "rootUri": root_uri,
        "capabilities": {
            "textDocument": {"synchronization": {"didSave": false}},
            "workspace": {"workspaceEdit": false}
        },
        "workspaceFolders": [{"uri": root_uri, "name": workspace}],
        "initializationOptions": init_options,
    });
    let (msg, id, tx, rx) = handle.router.next_request("initialize", params);
    handle.transport.table.lock().await.insert(id, tx);
    handle
        .transport
        .send(&msg)
        .await
        .map_err(|e| EnsureError::HandshakeFailed(e.to_string()))?;
    // 5s 握手判活（非请求超时——照 spec §8）
    let _result = match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
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
