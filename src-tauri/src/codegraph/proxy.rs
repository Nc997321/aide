//! `CodeGraphService` —— aide-codegraph.exe 的主进程侧代理。
//!
//! 职责（照抄 agent-sidecar 的进程管理模式）：
//! - **惰性拉起**：第一次 RPC 调用时才 spawn runner（codegraph 从不用的
//!   用户零成本）；
//! - **崩溃惰性重启**：runner 意外退出 → 在途请求失败（错误串回给调用方，
//!   与迁移前 command 出错的路径一致），下次调用自动重新拉起；若上一代
//!   曾有就绪索引，重启后后台 warm reload（磁盘索引 load 快路径，秒级）；
//! - **空闲回收**：15 分钟无活动且无在途请求/构建 → 发 `shutdown`，runner
//!   自行退出，下次调用再拉起（进程隔离的核心收益：RSS 归零）；
//! - **进度镜像**：runner 的 `progress` 通知回写本进程 atomics，
//!   `codegraph_build_progress` 同步轮询命令照旧读它们——前端合同不变。
//!
//! 通信合同：crates/codegraph-core 的 `protocol` 模块（主/runner 两侧共用，
//! 改协议 = 双侧编译期对账）。一行一条 JSON：
//! 请求 `{id, method, params}` / 响应 `{id, ok, result|error}` /
//! 通知 `{notification, ...payload}`。
//!
//! 看门狗：不需要心跳——主进程死亡 ⇒ runner stdin EOF ⇒ runner 自行退出。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
// 锁中毒策略（全局统一）：本文件的 std Mutex 保护的都是简单簿记字段
// （Option<Runner>/HashMap/String/Instant），持锁方 panic 不会破坏不变量；
// 而中毒即 panic 会击穿主进程——与进程隔离的目标背道而驰。故一律
// `unwrap_or_else(PoisonError::into_inner)` 恢复 guard 而非 panic。
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as TokioMutex};

use codegraph_core::protocol::{
    methods, notifications, ProgressPayload, RpcNotification, RpcRequest, RpcResponse,
};
use codegraph_core::types::QueryResult;
use codegraph_core::RuntimeCodeGraphEmbedderConfig;

use super::embed_config::load_embedder_config;

/// 空闲多久后回收 runner（无在途请求且无构建活动）。
const IDLE_REAP_AFTER: Duration = Duration::from_secs(15 * 60);
/// 空闲检查周期。
const IDLE_CHECK_TICK: Duration = Duration::from_secs(60);

pub struct CodeGraphService {
    /// setup 阶段注入（manage 先于 setup，AppHandle 只能后挂）。
    app: OnceLock<AppHandle>,
    inner: Arc<Inner>,
}

struct Inner {
    /// 当前 runner（None = 未运行/已退出）。generation 用于让旧 reader/reaper
    /// 任务识别「自己那一代 runner 已经被换掉」，避免误清新一代。
    proc: Mutex<Option<Runner>>,
    /// 串行化 spawn 路径（防止并发首调双拉起）。锁内无 await 长操作。
    spawn_lock: TokioMutex<()>,
    next_id: AtomicU64,
    generation: AtomicU64,
    /// id → 响应回调。响应到达/runner 退出时摘除。
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    // 进度镜像：形状与迁移前 `codegraph_build_progress` 的返回完全一致。
    build_active: AtomicBool,
    build_done: AtomicUsize,
    build_total: AtomicUsize,
    build_current: Mutex<String>,
    /// 结构层就绪（磁盘索引在、runner 里 ProjectIndex 已换入）。runner 被
    /// 空闲回收后仍保持 true——磁盘索引还在，warm reload 依据它。
    index_ready: AtomicBool,
    /// 最近一次 RPC 写出时间（空闲回收依据）。
    last_activity: Mutex<Instant>,
    /// 最近一次成功构建/加载索引的 root（warm reload 目标）。close 时清空。
    last_root: Mutex<Option<String>>,
    /// 异常退出计数（诊断用；正常 shutdown 不计）。
    pub(crate) restarts: AtomicUsize,
}

struct Runner {
    stdin: Arc<TokioMutex<ChildStdin>>,
    generation: u64,
}

impl CodeGraphService {
    pub fn new() -> Self {
        Self {
            app: OnceLock::new(),
            inner: Arc::new(Inner {
                proc: Mutex::new(None),
                spawn_lock: TokioMutex::new(()),
                next_id: AtomicU64::new(1),
                generation: AtomicU64::new(0),
                pending: Mutex::new(HashMap::new()),
                build_active: AtomicBool::new(false),
                build_done: AtomicUsize::new(0),
                build_total: AtomicUsize::new(0),
                build_current: Mutex::new(String::new()),
                index_ready: AtomicBool::new(false),
                last_activity: Mutex::new(Instant::now()),
                last_root: Mutex::new(None),
                restarts: AtomicUsize::new(0),
            }),
        }
    }

    /// setup 阶段注入 AppHandle（资源目录解析 / settings 访问）。幂等。
    pub fn attach(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    fn app_handle(&self) -> Result<AppHandle, String> {
        self.app
            .get()
            .cloned()
            .ok_or_else(|| "codegraph service not attached".to_string())
    }

    fn runner_alive(inner: &Inner) -> bool {
        inner
            .proc
            .lock()
            .map(|g| g.is_some())
            .unwrap_or_else(|p| p.into_inner().is_some())
    }

    // ── 公开 RPC 包装（命令桩 / agent 桥的调用面） ──────────────────────

    /// `build_index`：分钟级长请求（invoke 全程 await，语义与迁移前的
    /// Tauri command 一致），期间进度经通知持续刷新镜像。
    pub async fn build_index(
        &self,
        project_root: &str,
        force: bool,
        cfg: RuntimeCodeGraphEmbedderConfig,
        proxy: Option<String>,
    ) -> Result<Value, String> {
        self.ensure_running().await?;
        let res = self
            .roundtrip(
                methods::BUILD_INDEX,
                json!({
                    "project_root": project_root,
                    "force": force,
                    "embedder": cfg,
                    "proxy": proxy,
                }),
            )
            .await;
        // 请求已终结（ok / err / gate 早退）⇒ 本进程不再认为有构建在跑。
        //
        // runner 侧的 build_active 存在不复位的早退路径（build.rs:275 的 Phase 1
        // 失败 `?`、锁中毒 `?`——复位只在 187/201 两条复用路径与 421 正常完成），
        // 泄漏后 progress 通知会一直报 active=true。进度镜像的拥有者是本进程，
        // 所以由这里兜底收敛：否则 idle_reaper 永判 busy、runner 永不空闲回收
        // （进程隔离的核心收益——RSS 归零——直接失效）。
        //
        // 安全性：runner 的 Phase 2 与 resume 都是**同步**跑完才回响应
        // （build.rs:421 / resume.rs:157），不存在「响应已回、构建还在后台」的
        // 窗口，因此收敛不会掐掉在途构建。
        self.inner.build_active.store(false, Ordering::Relaxed);
        let v = res?;
        // 记住成功路径的 root：空闲回收/崩溃重启后的 warm reload 目标。
        if v.get("skipped").is_none() {
            *self
                .inner
                .last_root
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(project_root.to_string());
        }
        Ok(v)
    }

    /// `goto_definition`：可与 build 并发（runner 内 spawn_blocking 分发，
    /// 锁语义与进程隔离前一致）。
    pub async fn goto_definition(
        &self,
        word: &str,
        file: &str,
        line: usize,
        column: usize,
        project_root: &str,
        score_threshold: f32,
    ) -> Result<Vec<QueryResult>, String> {
        self.ensure_running().await?;
        let v = self
            .roundtrip(
                methods::GOTO_DEFINITION,
                json!({
                    "word": word,
                    "file": file,
                    "line": line,
                    "column": column,
                    "project_root": project_root,
                    "score_threshold": score_threshold,
                }),
            )
            .await?;
        serde_json::from_value(v).map_err(|e| format!("runner response decode: {e}"))
    }

    /// `close`：runner 没在跑就没什么可关的（内存索引随进程消亡）。
    pub async fn close(&self, project_root: &str) -> Result<(), String> {
        *self
            .inner
            .last_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
        if !Self::runner_alive(&self.inner) {
            return Ok(());
        }
        self.roundtrip(methods::CLOSE, json!({ "project_root": project_root }))
            .await
            .map(|_| ())
    }

    /// `reindex_file`：保存触发的单文件增量。
    pub async fn reindex_file(&self, project_root: &str, file: &str) -> Result<Value, String> {
        self.ensure_running().await?;
        self.roundtrip(
            methods::REINDEX_FILE,
            json!({ "project_root": project_root, "file": file }),
        )
        .await
    }

    /// `rescan`：手动「更新索引」。
    pub async fn rescan(&self, project_root: &str) -> Result<Value, String> {
        self.ensure_running().await?;
        self.roundtrip(methods::RESCAN, json!({ "project_root": project_root }))
            .await
    }

    /// `agent_query`：agent-sidecar 的 codegraph 工具查询。`trusted` 在本层
    /// 计算（信任是政策）后传入——runner 盲执行。
    pub async fn agent_query(
        &self,
        tool: &str,
        args: &Value,
        project_root: &str,
        trusted: bool,
        score_threshold: f32,
    ) -> Result<Value, String> {
        self.ensure_running().await?;
        self.roundtrip(
            methods::AGENT_QUERY,
            json!({
                "tool": tool,
                "args": args,
                "project_root": project_root,
                "trusted": trusted,
                "score_threshold": score_threshold,
            }),
        )
        .await
    }

    /// 进度快照：`codegraph_build_progress` 轮询命令的数据源。纯内存读，
    /// 同步调用（迁移前该命令就是同步 inline 命令——freeze 硬化的一部分）。
    pub fn progress_snapshot(&self) -> Value {
        let current = self
            .inner
            .build_current
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|p| p.into_inner().clone());
        // 与 runner 侧 methods::progress_snapshot 同源：序列化同一个
        // `ProgressPayload`（跨进程合同类型），而不是手拼同样五个键的 json——
        // 手拼版本在给 ProgressPayload 加字段时不会报错，会静默丢字段。
        let payload = ProgressPayload {
            active: self.inner.build_active.load(Ordering::Relaxed),
            done: self.inner.build_done.load(Ordering::Relaxed),
            total: self.inner.build_total.load(Ordering::Relaxed),
            current,
            index_ready: self.inner.index_ready.load(Ordering::Relaxed),
        };
        // 静态形状的序列化不会失败；真失败时退化为带 error 的对象，好过
        // 悄悄返回空对象让前端按 undefined 处理。
        serde_json::to_value(payload).unwrap_or_else(|e| json!({ "error": e.to_string() }))
    }

    // ── runner 生命周期 ────────────────────────────────────────────────

    /// 惰性拉起（double-check + spawn_lock 防并发双拉起）。
    async fn ensure_running(&self) -> Result<(), String> {
        if Self::runner_alive(&self.inner) {
            return Ok(());
        }
        let _guard = self.inner.spawn_lock.lock().await;
        if Self::runner_alive(&self.inner) {
            return Ok(());
        }
        let app = self.app_handle()?;
        self.spawn_runner(&app)
    }

    // 注意：本函数体内没有任何 await（长任务全部 tokio::spawn 出去），故意
    // 用同步签名——避免 async fn 包装引入的 Send 推断噪音。
    fn spawn_runner(&self, app: &AppHandle) -> Result<(), String> {
        use tauri::Manager;

        let bin = resolve_runner_path(app)?;
        let mut cmd = Command::new(&bin);
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            // release 无控制台窗口
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // release：把打包资源目录注入（runner 内本地 ONNX 模型解析）。
        // dev 不设——runner 走 CARGO_MANIFEST_DIR 源码树回退。
        #[cfg(not(debug_assertions))]
        {
            if let Ok(res_dir) = app.path().resource_dir() {
                cmd.env("AIDE_CODEGRAPH_MODEL_DIR", dunce::simplified(&res_dir));
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动 codegraph runner（{bin:?}）：{e}"))?;
        let stdin = child.stdin.take().ok_or("runner stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("runner stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("runner stderr unavailable")?;

        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut guard = self
                .inner
                .proc
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *guard = Some(Runner {
                stdin: Arc::new(TokioMutex::new(stdin)),
                generation,
            });
        }
        tracing::info!("codegraph runner spawned (gen={generation}, bin={bin:?})");

        // reader 任务：唯一消费 runner stdout 的地方；持有 Child 负责收尸。
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                handle_line(&inner, &line);
            }
            // EOF / 管道断 —— runner 退出
            let status = child.wait().await;
            runner_gone(&inner, generation, status);
        });

        // runner stderr → 主进程日志（tracing 落盘随主进程走）。
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(target: "codegraph-runner", "{line}");
            }
        });

        // 空闲回收任务：只管自己这一代。
        let inner = self.inner.clone();
        tokio::spawn(idle_reaper(inner, generation));

        // warm reload：上一代曾有就绪索引（被空闲回收/崩溃清掉）→ 后台重放
        // build_index（磁盘索引 load 快路径）。与前端 ensureIndex 的并发
        // 安全性由 runner 内建的 build_cancel 串行化保证（与迁移前一致）。
        // 注意：last_root 的 MutexGuard 必须在语句内收尾——若写在 if let 的
        // scrutinee 里（edition 2021），guard 会活到整个 if 块结束并横跨下方
        // await，导致 future !Send、无法 tokio::spawn。
        let warm_root = self
            .inner
            .last_root
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if self.inner.index_ready.load(Ordering::Relaxed) {
            if let Some(root) = warm_root {
                let svc = CodeGraphService {
                    app: OnceLock::new(),
                    inner: self.inner.clone(),
                };
                let _ = svc.app.set(app.clone());
                let app2 = app.clone();
                tokio::spawn(async move {
                    let prep = tokio::task::spawn_blocking(move || {
                        let cfg = app2
                            .try_state::<Arc<crate::settings::SettingsService>>()
                            .map(|s| load_embedder_config(s.inner()))?;
                        let proxy = crate::commands::proxy::detect_proxy();
                        Some((cfg, proxy))
                    })
                    .await;
                    match prep {
                        Ok(Some((cfg, proxy))) => {
                            if let Err(e) = svc.build_index(&root, false, cfg, proxy).await {
                                tracing::warn!("codegraph: warm reload after respawn failed: {e}");
                            }
                        }
                        _ => {
                            tracing::warn!("codegraph: warm reload skipped (settings unavailable)")
                        }
                    }
                });
            }
        }
        Ok(())
    }

    // ── RPC 往返 ───────────────────────────────────────────────────────

    /// 一次请求-响应往返。先挂 pending 再写 stdin（响应可能极快到达）；
    /// 任何一步失败都要把 pending 摘干净，避免泄漏 sender。
    async fn roundtrip(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, tx);

        let stdin_arc = {
            let guard = self
                .inner
                .proc
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            guard.as_ref().map(|r| r.stdin.clone())
        };
        let Some(stdin_arc) = stdin_arc else {
            self.inner
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&id);
            return Err("codegraph runner is not running".into());
        };

        let req = RpcRequest {
            id,
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
        {
            let mut w = stdin_arc.lock().await;
            // 两次 write_all 顺序 await（and_then 闭包不能是 async）
            let written = match w.write_all(line.as_bytes()).await {
                Ok(()) => w.write_all(b"\n").await,
                Err(e) => Err(e),
            };
            if let Err(e) = written {
                self.inner
                    .pending
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id);
                return Err(format!("write to codegraph runner failed: {e}"));
            }
        }
        *self
            .inner
            .last_activity
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Instant::now();

        match rx.await {
            Ok(res) => res,
            Err(_) => Err("codegraph runner exited before responding".into()),
        }
    }
}

/// 解析 runner 二进制路径：dev = cargo target/debug（需先 `pnpm
/// build:codegraph`），release = 打包资源目录 `codegraph/` 子目录（与
/// agent-runtime 同模式）。
fn resolve_runner_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let name = if cfg!(windows) {
            "aide-codegraph.exe"
        } else {
            "aide-codegraph"
        };
        let path = manifest.join("target").join("debug").join(name);
        if path.exists() {
            return Ok(dunce::simplified(&path).to_path_buf());
        }
        Err(format!(
            "codegraph runner 未构建（{:?}）——先运行 pnpm build:codegraph",
            path
        ))
    }
    #[cfg(not(debug_assertions))]
    {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
        let name = if cfg!(windows) {
            "aide-codegraph.exe"
        } else {
            "aide-codegraph"
        };
        let path = resource_dir.join("codegraph").join(name);
        if path.exists() {
            return Ok(dunce::simplified(&path).to_path_buf());
        }
        Err(format!("codegraph runner exe missing: {path:?}"))
    }
}

/// reader 任务的行分发：响应 → pending 路由；通知 → 进度镜像 / 日志。
fn handle_line(inner: &Inner, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    // 响应必有 id（u64）；通知没有 id，from_str 必失败——顺序试探即可。
    if let Ok(resp) = serde_json::from_str::<RpcResponse>(line) {
        if let Some(tx) = inner
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&resp.id)
        {
            if resp.ok {
                let _ = tx.send(Ok(resp.result.unwrap_or(Value::Null)));
            } else {
                let _ = tx.send(Err(resp
                    .error
                    .unwrap_or_else(|| "unknown runner error".into())));
            }
        } else {
            tracing::debug!("codegraph runner: response {} has no waiter", resp.id);
        }
        return;
    }
    if let Ok(n) = serde_json::from_str::<RpcNotification>(line) {
        match n.notification.as_str() {
            notifications::PROGRESS => {
                if let Ok(p) = serde_json::from_value::<ProgressPayload>(n.payload) {
                    inner.build_active.store(p.active, Ordering::Relaxed);
                    inner.build_done.store(p.done, Ordering::Relaxed);
                    inner.build_total.store(p.total, Ordering::Relaxed);
                    inner.index_ready.store(p.index_ready, Ordering::Relaxed);
                    *inner
                        .build_current
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = p.current;
                }
            }
            notifications::LOG => {
                let level = n
                    .payload
                    .get("level")
                    .and_then(|v| v.as_str())
                    .unwrap_or("info");
                let msg = n
                    .payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                match level {
                    "ERROR" => tracing::error!(target: "codegraph-runner", "{msg}"),
                    "WARN" => tracing::warn!(target: "codegraph-runner", "{msg}"),
                    _ => tracing::info!(target: "codegraph-runner", "{msg}"),
                }
            }
            other => tracing::debug!("codegraph runner: unknown notification {other}"),
        }
        return;
    }
    tracing::warn!("codegraph runner: malformed line: {line}");
}

/// runner 退出（崩溃/正常 shutdown）后的善后：清 proc（只清自己那一代）、
/// 失败全部在途请求、进度镜像收敛到 idle。
fn runner_gone(
    inner: &Inner,
    generation: u64,
    status: Result<std::process::ExitStatus, std::io::Error>,
) {
    {
        let mut guard = inner.proc.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.as_ref().map(|r| r.generation) == Some(generation) {
            *guard = None;
        }
    }
    let mut pending = inner.pending.lock().unwrap_or_else(PoisonError::into_inner);
    for (_, tx) in pending.drain() {
        let _ = tx.send(Err("codegraph runner exited unexpectedly".to_string()));
    }
    drop(pending);
    // active 收敛为 false（前端轮询看到 done/none）；index_ready 保留——
    // 磁盘索引仍在，warm reload / 下次 build 的 load 快路径可用。
    inner.build_active.store(false, Ordering::Relaxed);
    match status {
        Ok(s) if s.success() => {
            tracing::info!("codegraph runner exited cleanly (gen={generation})")
        }
        Ok(s) => {
            inner.restarts.fetch_add(1, Ordering::Relaxed);
            tracing::warn!("codegraph runner exited: {s} (gen={generation})——下次调用时自动重启");
        }
        Err(e) => {
            inner.restarts.fetch_add(1, Ordering::Relaxed);
            tracing::warn!("codegraph runner wait failed: {e} (gen={generation})");
        }
    }
}

/// 空闲回收任务：超时且不忙时发 `shutdown`（runner 应答后自行退出，善后
/// 由 reader EOF 路径完成）。只对自己那一代 runner 生效。
async fn idle_reaper(inner: Arc<Inner>, generation: u64) {
    loop {
        tokio::time::sleep(IDLE_CHECK_TICK).await;
        let still_current = inner
            .proc
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|r| r.generation == generation)
            .unwrap_or(false);
        if !still_current {
            return;
        }
        let busy = inner.build_active.load(Ordering::Relaxed)
            || !inner
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty();
        if busy {
            continue;
        }
        let idle = inner
            .last_activity
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .elapsed();
        if idle < IDLE_REAP_AFTER {
            continue;
        }
        tracing::info!(
            "codegraph runner idle {}min — shutting down",
            idle.as_secs() / 60
        );
        let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
        let line = match serde_json::to_string(&RpcRequest {
            id,
            method: methods::SHUTDOWN.to_string(),
            params: Value::Null,
        }) {
            Ok(l) => l,
            // 序列化静态形状不可能失败；真失败说明类型改坏了，记日志而非
            // 写空行给 runner（空行会被当 malformed 丢弃，掩盖问题）。
            Err(e) => {
                tracing::warn!("codegraph: serialize shutdown request failed: {e}");
                continue;
            }
        };
        let stdin_arc = inner
            .proc
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|r| r.stdin.clone());
        if let Some(stdin) = stdin_arc {
            // try_lock 失败 = 恰有请求在写（罕见，busy 检查后竞态窗口极小）：
            // 本轮放弃，下个 tick 再试。
            if let Ok(mut w) = stdin.try_lock() {
                let _ = w.write_all(line.as_bytes()).await;
                let _ = w.write_all(b"\n").await;
                let _ = w.flush().await;
                return; // reaper 使命结束；proc 清理由 reader EOF 路径负责
            }
        }
    }
}
