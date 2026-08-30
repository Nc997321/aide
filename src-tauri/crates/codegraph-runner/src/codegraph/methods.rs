//! RPC 方法实现（runner 侧）：原 `codegraph/commands.rs` 的命令体改造为
//! 进程协议方法。变更对账（相对迁移前）：
//!
//! | 原命令                          | 方法                | 差异                              |
//! |--------------------------------|---------------------|-----------------------------------|
//! | codegraph_build_index          | build_index         | 门控/ensure_aide_excluded 移主进程；embedder 配置+proxy 由参数传入 |
//! | codegraph_goto_definition      | goto_definition     | score_threshold 由参数传入（原读 settings） |
//! | codegraph_close                | close               | 无差异                            |
//! | codegraph_reindex_file         | reindex_file        | 门控移主进程                      |
//! | codegraph_rescan               | rescan              | 门控移主进程                      |
//! | （runtime 内联调用）            | agent_query         | trusted 由主进程计算传入          |
//!
//! 所有方法为同步函数：runner main 的分发器已在 `spawn_blocking` 里调用它们，
//! 与迁移前 Tauri command 的 `spawn_blocking` 并发模型一致（std 锁 + 阻塞池）。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use codegraph_core::protocol::RpcResponse;
use codegraph_core::types::QueryResult;
use codegraph_core::RuntimeCodeGraphEmbedderConfig;

use super::agent;
use super::build;
use super::query;
use super::state::CodeGraphState;

/// `build_index { project_root, force, embedder, proxy }` → 构建结果 JSON。
pub fn build_index(
    st: &Arc<CodeGraphState>,
    project_root: &str,
    force: bool,
    cfg: &RuntimeCodeGraphEmbedderConfig,
    proxy: Option<&str>,
) -> Result<Value, String> {
    build::build_index(st, project_root, force, cfg, proxy)
}

/// `goto_definition { word, file, line, column, project_root, score_threshold }`
/// → `Vec<QueryResult>`。
///
/// 结构层（精确、跨文件）跑在读锁下；shard Arc 与 embed_ready 原子地一并
/// clone 出来、读锁先 drop 再做语义 embed——ONNX 前向不阻塞其他读者。
pub fn goto_definition(
    st: &Arc<CodeGraphState>,
    word: &str,
    #[allow(unused_variables)] file: &str,
    line: usize,
    #[allow(unused_variables)] column: usize,
    #[allow(unused_variables)] project_root: &str,
    score_threshold: f32,
) -> Result<Vec<QueryResult>, String> {
    // 1. structure (exact, cross-file) under a read lock; clone shard Arc out
    //    atomically with embed_ready (TOCTOU: reading them under separate locks
    //    could swap in a mid-embed shard after we passed the embed_ready gate).
    let (structure, shard_arc, embed_ready) = {
        let guard = st.inner.read().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            None => return Ok(vec![]),
            Some(pi) => (
                query::structure::structure_lookup(word, &pi.symbols, line),
                pi.shard.clone(),
                pi.embed_ready.load(Ordering::Relaxed),
            ),
        }
    };
    if !structure.is_empty() {
        return Ok(structure);
    }
    // 2. semantic — only if embed has completed (embed_ready). While the
    //    background embed is filling the shard, skip semantic to avoid
    //    concurrent upsert (embed) + search (here) on the same shard, which
    //    Qdrant Edge does not guarantee safe. Frontend falls back to grep.
    if !embed_ready {
        return Ok(vec![]);
    }
    // lock embedder, embed word, search shard (read lock already dropped).
    let emb = st.embedder.lock().map_err(|e| e.to_string())?;
    if let Some(embedder) = emb.as_ref() {
        match query::semantic::semantic_search(
            word,
            embedder.as_ref(),
            &shard_arc,
            10,
            score_threshold,
        ) {
            Ok(mut r) => {
                r.sort_by(|a, b| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                return Ok(r);
            }
            Err(e) => tracing::warn!("codegraph: semantic search failed: {}", e),
        }
    }
    Ok(vec![])
}

/// `close { project_root }` → 关闭并 flush 当前索引。
///
/// Optimizes the shard and drops the active index so its resources are
/// released. symbols.json / meta.json were already persisted at build time.
pub fn close(st: &Arc<CodeGraphState>, _project_root: &str) -> Result<(), String> {
    // Cancel any in-flight background embed so it stops at the next batch
    // instead of continuing to write an orphaned shard (the ProjectIndex we
    // take below). The embed task holds its own shard Arc, so the writes are
    // memory-safe even without cancellation — this just avoids wasting CPU.
    st.build_cancel.store(true, Ordering::Relaxed);
    // Take the index OUT of the lock, then drop the write guard immediately
    // so optimize() + the index drop never run while `inner` is held. A
    // Qdrant EdgeShard flush panic during optimize/drop used to poison
    // `inner` here (the close path in the backtrace: mod.rs:454/475).
    let taken = {
        let mut guard = match st.inner.write() {
            Ok(g) => g,
            // Already poisoned (shouldn't happen with the swap fix above,
            // but be defensive): nothing live to close.
            Err(_) => return Ok(()),
        };
        guard.take()
    };
    if let Some(pi) = taken {
        // optimize() may itself flush → panic; catch it so close never
        // unwinds with the lock held.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Err(e) = pi.shard.optimize() {
                tracing::warn!("codegraph: optimize on close failed: {}", e);
            }
        }));
        // Drop the project index (and its shard) OUTSIDE the lock with
        // panic guarding — the shard's EdgeShard::drop flush can panic on
        // IO error. symbols.json / meta.json were already persisted at
        // build/reindex time, so a suppressed drop panic loses nothing
        // that can't be rebuilt.
        super::guard::drop_catching_panics(pi, "old project index (close)");
    }
    Ok(())
}

/// `reindex_file { project_root, file }` → 状态 JSON。
///
/// Returns a structured status so the frontend can tell what happened. Possible
/// results（与迁移前完全一致）:
///   `{ "reindexed": true }`                       — file re-parsed + re-embedded
///   `{ "reindexed": false, "skipped": "..." }`    — no-op, with the reason:
///       `no_active_index`  — no index in memory (not built yet / closed)
///       `not_in_project`   — active index is for a different project root
///       `embed_not_ready`  — background embed still running (or stopped early)
///   `Err(...)`                                    — reindex ran but failed
///
/// The write lock is held for the whole single-file reindex (drop stale →
/// re-parse → embed → re-persist): this serializes Qdrant shard access, at the
/// cost of briefly blocking goto queries during the embed (well under 100ms for
/// a typical file).
pub fn reindex_file(
    st: &Arc<CodeGraphState>,
    project_root: &str,
    file: &str,
) -> Result<Value, String> {
    let root = std::path::PathBuf::from(project_root);
    let abs = std::path::PathBuf::from(file);

    // Only reindex if it belongs to the active project.
    let mut guard = st.inner.write().map_err(|e| e.to_string())?;
    let pi = match guard.as_mut() {
        Some(pi) if pi.project_root == root => pi,
        Some(_) => {
            tracing::info!(
                "codegraph: save reindex skipped (not_in_project) file={} active_root!={:?}",
                abs.display(),
                root
            );
            return Ok(json!({ "reindexed": false, "skipped": "not_in_project" }));
        }
        None => {
            tracing::info!(
                "codegraph: save reindex skipped (no_active_index) file={}",
                abs.display()
            );
            return Ok(json!({ "reindexed": false, "skipped": "no_active_index" }));
        }
    };
    // Skip while the background embed is still filling the shard — concurrent
    // upsert (embed) + upsert (reindex) on the same shard isn't guaranteed
    // safe by Qdrant Edge. The save-triggered change is picked up by the next
    // full rebuild (is_stale mtime check); skipping here is safe. This also
    // covers a build whose embed STOPPED EARLY (e.g. bge-m3 NaN) — embed_ready
    // never flips true, so every save is a no-op until a clean rebuild
    // completes. Surfacing `embed_not_ready` makes that visible instead of
    // silent.
    if !pi.embed_ready.load(Ordering::Relaxed) {
        tracing::info!(
            "codegraph: save reindex skipped (embed_not_ready) file={}",
            abs.display()
        );
        return Ok(json!({ "reindexed": false, "skipped": "embed_not_ready" }));
    }
    // Read the cached embedder identity (model_name + dim) to stamp into the
    // re-persisted meta. Falls back to the fastembed default if no embedder
    // is configured (structure-only build) — matches what build stamped.
    let (model_name, dim) = st
        .embedder_model
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .unwrap_or_else(|| ("fastembed:all-MiniLM-L6-v2".to_string(), 384));
    let emb = st.embedder.lock().map_err(|e| e.to_string())?;
    let embedder_ref: Option<&dyn super::embed::Embedder> = emb.as_ref().map(|b| b.as_ref());
    // Clone the shard Arc out so reindex_one borrows &mut pi.symbols
    // without aliasing the shard reference.
    let shard = pi.shard.clone();
    super::indexer::reindex_one(
        &root,
        &abs,
        &mut pi.symbols,
        &mut pi.edges,
        &shard,
        embedder_ref,
        &model_name,
        dim,
        &st.parser_manager,
    )
    .map_err(|e| format!("reindex failed: {}", e))?;
    tracing::info!("codegraph: save reindex ok file={}", abs.display());
    Ok(json!({ "reindexed": true }))
}

/// `rescan { project_root }` → 状态 JSON（手动「更新索引」按钮）。
///
/// Walks the project, finds source files with mtime > the index's `indexed_at`,
/// and reindexes only those via `reindex_one`. Unchanged files keep their
/// existing symbols/vectors. No-op if no index is built, the root doesn't
/// match, or the background embed hasn't finished. Per-file write locks are
/// released between files so goto queries can interleave.
pub fn rescan(st: &Arc<CodeGraphState>, project_root: &str) -> Result<Value, String> {
    let root = std::path::PathBuf::from(project_root);
    // Snapshot indexed_at + embed_ready under a read lock; bail if no index
    // or the active index is for a different root.
    let indexed_at = {
        let guard = st.inner.read().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            None => {
                return Ok(json!({
                    "active_index": false,
                    "rescanned_files": 0,
                }));
            }
            Some(pi) => {
                if pi.project_root != root {
                    return Ok(json!({
                        "active_index": false,
                        "rescanned_files": 0,
                    }));
                }
                if !pi.embed_ready.load(Ordering::Relaxed) {
                    return Ok(json!({
                        "active_index": true,
                        "embed_ready": false,
                        "rescanned_files": 0,
                    }));
                }
                pi.indexed_at
            }
        }
    };

    // Walk + find changed files (mtime strictly after indexed_at — built
    // during this index's lifetime). Same walk as the build (gitignore +
    // junk-dir blacklist + max-filesize), so rescan sees exactly the files
    // the build would.
    let exts = st.parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = exts.to_vec();
    let files = super::indexer::walk::walk_source_files(&root, &ext_refs);
    let changed: Vec<std::path::PathBuf> = files
        .into_iter()
        .filter(|f| {
            f.metadata()
                .and_then(|m| m.modified())
                .ok()
                .map(|mt| mt > indexed_at)
                .unwrap_or(false)
        })
        .collect();

    let (model_name, dim) = st
        .embedder_model
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .unwrap_or_else(|| ("fastembed:all-MiniLM-L6-v2".to_string(), 384));

    let mut rescanned = 0usize;
    let mut errors = 0usize;
    for abs in &changed {
        // Per-file write lock (released at end of iteration) so goto can
        // interleave between files. Same inner→embedder lock order as
        // reindex_file (build never holds both, so no deadlock cycle).
        let mut guard = st.inner.write().map_err(|e| e.to_string())?;
        let pi = match guard.as_mut() {
            Some(pi) => pi,
            None => break, // index closed mid-rescan — stop
        };
        if !pi.embed_ready.load(Ordering::Relaxed) {
            break;
        }
        let emb = st.embedder.lock().map_err(|e| e.to_string())?;
        let embedder_ref: Option<&dyn super::embed::Embedder> = emb.as_ref().map(|b| b.as_ref());
        let shard = pi.shard.clone();
        match super::indexer::reindex_one(
            &root,
            abs,
            &mut pi.symbols,
            &mut pi.edges,
            &shard,
            embedder_ref,
            &model_name,
            dim,
            &st.parser_manager,
        ) {
            Ok(_) => rescanned += 1,
            Err(e) => {
                tracing::warn!("codegraph: rescan reindex failed {}: {}", abs.display(), e);
                errors += 1;
            }
        }
    }

    Ok(json!({
        "active_index": true,
        "embed_ready": true,
        "changed_files": changed.len(),
        "rescanned_files": rescanned,
        "errors": errors,
    }))
}

/// `agent_query { tool, args, project_root, trusted, score_threshold }` → 结果
/// JSON。`trusted` 由主进程计算——信任是政策，归属主进程；本进程是机制。
pub fn agent_query(
    st: &Arc<CodeGraphState>,
    tool: &str,
    args: &Value,
    project_root: &str,
    trusted: bool,
    score_threshold: f32,
) -> Value {
    agent::execute_agent_query(st, tool, args, project_root, trusted, score_threshold)
}

// ─────────────────────────────────────────────────────────────────────────────
// dispatch：runner main 的唯一入口。收在 lib（而非 bin）是因为它要触
// `CodeGraphState` 的 `pub(crate)` 字段/内部模块——bin target 对本包 lib 是
// 外部 crate，看不到 `pub(crate)`。main 只做 IO 编解码与并发分发。
// ─────────────────────────────────────────────────────────────────────────────

/// 参数反序列化失败也算「请求失败」（而非协议错误）：同一 id 回 err 响应，
/// 主进程的 invoke 会拿到 Err 字符串，与旧 Tauri command 的报错路径一致。
fn bad_params(e: serde_json::Error) -> String {
    format!("bad params: {e}")
}

/// RPC 分发器：`(id, method, params)` → `RpcResponse`。在 `spawn_blocking`
/// 里被调用（由 runner main 负责），因此这里的锁语义与迁移前 Tauri command
/// 的 `spawn_blocking` 完全同构——build 分钟级长请求期间，goto 等“读”请求
/// 照常并发进入。
pub fn dispatch(st: &Arc<CodeGraphState>, id: u64, method: &str, params: &Value) -> RpcResponse {
    let res: Result<Value, String> = match method {
        codegraph_core::protocol::methods::BUILD_INDEX => {
            #[derive(Deserialize)]
            struct P {
                project_root: String,
                #[serde(default)]
                force: bool,
                embedder: RuntimeCodeGraphEmbedderConfig,
                #[serde(default)]
                proxy: Option<String>,
            }
            match serde_json::from_value::<P>(params.clone()).map_err(bad_params) {
                Ok(p) => build_index(
                    st,
                    &p.project_root,
                    p.force,
                    &p.embedder,
                    p.proxy.as_deref(),
                ),
                Err(e) => Err(e),
            }
        }
        codegraph_core::protocol::methods::GOTO_DEFINITION => {
            #[derive(Deserialize)]
            struct P {
                word: String,
                #[serde(default)]
                file: String,
                #[serde(default)]
                line: usize,
                #[serde(default)]
                column: usize,
                #[serde(default)]
                project_root: String,
                #[serde(default)]
                score_threshold: f32,
            }
            match serde_json::from_value::<P>(params.clone()).map_err(bad_params) {
                Ok(p) => goto_definition(
                    st,
                    &p.word,
                    &p.file,
                    p.line,
                    p.column,
                    &p.project_root,
                    p.score_threshold,
                )
                .and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())),
                Err(e) => Err(e),
            }
        }
        codegraph_core::protocol::methods::CLOSE => {
            #[derive(Deserialize)]
            struct P {
                #[serde(default)]
                project_root: String,
            }
            match serde_json::from_value::<P>(params.clone()).map_err(bad_params) {
                Ok(p) => close(st, &p.project_root).map(|_| Value::Null),
                Err(e) => Err(e),
            }
        }
        codegraph_core::protocol::methods::REINDEX_FILE => {
            #[derive(Deserialize)]
            struct P {
                project_root: String,
                file: String,
            }
            match serde_json::from_value::<P>(params.clone()).map_err(bad_params) {
                Ok(p) => reindex_file(st, &p.project_root, &p.file),
                Err(e) => Err(e),
            }
        }
        codegraph_core::protocol::methods::RESCAN => {
            #[derive(Deserialize)]
            struct P {
                project_root: String,
            }
            match serde_json::from_value::<P>(params.clone()).map_err(bad_params) {
                Ok(p) => rescan(st, &p.project_root),
                Err(e) => Err(e),
            }
        }
        codegraph_core::protocol::methods::AGENT_QUERY => {
            #[derive(Deserialize)]
            struct P {
                tool: String,
                #[serde(default)]
                args: Value,
                project_root: String,
                #[serde(default)]
                trusted: bool,
                #[serde(default)]
                score_threshold: f32,
            }
            match serde_json::from_value::<P>(params.clone()).map_err(bad_params) {
                Ok(p) => Ok(agent_query(
                    st,
                    &p.tool,
                    &p.args,
                    &p.project_root,
                    p.trusted,
                    p.score_threshold,
                )),
                Err(e) => Err(e),
            }
        }
        other => Err(format!("unknown method: {other}")),
    };
    match res {
        Ok(v) => RpcResponse::ok(id, v),
        Err(e) => RpcResponse::err(id, e),
    }
}

/// 进度快照：五个键的形状与主进程 `codegraph_build_progress` 轮询命令的返回
/// 值完全一致（前端合同不变）。runner main 的 250ms 通知任务读取它，经
/// `progress` 通知推给主进程回写 atomics。
pub fn progress_snapshot(st: &Arc<CodeGraphState>) -> codegraph_core::protocol::ProgressPayload {
    let current = st
        .build_current
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    // index_ready = a ProjectIndex is swapped in (structure layer usable for
    // exact goto) — true once Phase 1 finishes, even while the background embed
    // (Phase 2) is still running.
    let index_ready = st.inner.read().map(|g| g.is_some()).unwrap_or(false);
    codegraph_core::protocol::ProgressPayload {
        active: st.build_active.load(Ordering::Relaxed),
        done: st.build_done.load(Ordering::Relaxed),
        total: st.build_total.load(Ordering::Relaxed),
        current,
        index_ready,
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use codegraph_core::protocol::methods as m;

    #[test]
    fn unknown_method_returns_err_response() {
        let st = Arc::new(CodeGraphState::new());
        let resp = dispatch(&st, 9, "no_such_method", &json!({}));
        assert_eq!(resp.id, 9);
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("no_such_method"));
    }

    #[test]
    fn bad_params_return_err_not_panic() {
        let st = Arc::new(CodeGraphState::new());
        // reindex_file 缺 file 字段
        let resp = dispatch(&st, 3, m::REINDEX_FILE, &json!({"project_root": "/x"}));
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("bad params"));
    }

    #[test]
    fn goto_with_no_index_returns_empty_array() {
        let st = Arc::new(CodeGraphState::new());
        let resp = dispatch(
            &st,
            1,
            m::GOTO_DEFINITION,
            &json!({"word": "foo", "file": "a.ts", "line": 1, "column": 1, "project_root": "/x"}),
        );
        assert!(resp.ok);
        assert_eq!(resp.result.unwrap(), json!([]));
    }

    #[test]
    fn close_with_default_root_ok() {
        let st = Arc::new(CodeGraphState::new());
        let resp = dispatch(&st, 2, m::CLOSE, &json!({"project_root": "/x"}));
        assert!(resp.ok);
        assert_eq!(resp.result, Some(Value::Null));
    }

    #[test]
    fn progress_snapshot_idle_shape() {
        let st = Arc::new(CodeGraphState::new());
        let p = progress_snapshot(&st);
        assert!(!p.active);
        assert_eq!(p.done, 0);
        assert_eq!(p.total, 0);
        assert!(!p.index_ready);
        let v = serde_json::to_value(&p).unwrap();
        for key in ["active", "done", "total", "current", "index_ready"] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
    }

    /// shutdown 不走 dispatch（main 直接应答后退出），但协议常量必须在——
    /// 防止方法名被误删导致 main 编译期对账失败。
    #[test]
    fn protocol_method_constants_are_stable() {
        use codegraph_core::protocol::notifications;
        assert_eq!(m::SHUTDOWN, "shutdown");
        assert_eq!(notifications::PROGRESS, "progress");
        assert_eq!(notifications::LOG, "log");
    }
}
