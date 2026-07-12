pub mod indexer;
pub mod types;
pub mod shard;
pub mod embed;
pub mod parser;
pub mod query;
pub mod symbols;
pub mod meta;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

use crate::codegraph::embed::Embedder;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;

/// Snapshot of a fully-built project index, swapped atomically into state.
///
/// `embed_ready` gates the semantic layer: false while the background embed is
/// filling the shard (or if embed was cancelled / unavailable). goto-definition
/// serves the **structure layer (SymbolTable) immediately** after swap — it does
/// not need the shard — so users get exact cross-file jumps without waiting for
/// the slow ONNX embed. Semantic search (shard) is only consulted once
/// `embed_ready` becomes true, which avoids concurrent `upsert` (embed) +
/// `search` (goto) on the same shard (not guaranteed safe by Qdrant Edge).
pub struct ProjectIndex {
    pub project_root: PathBuf,
    pub symbols: SymbolTable,
    pub shard: Arc<CodeShard>,
    pub indexed_at: SystemTime,
    pub embed_ready: Arc<AtomicBool>,
}

/// Per-project code graph state.
///
/// `inner` is a double buffer: the active index is read under a read lock;
/// a rebuild builds a fresh `ProjectIndex` offline (in spawn_blocking) and
/// swaps it in under a brief write lock. `embedder` is a lazy-initialized
/// ONNX model guarded by its own mutex. Registered in Tauri state as
/// `Arc<CodeGraphState>` so each command can clone the Arc and move it into
/// a `spawn_blocking` closure (a `State<'_, _>` cannot cross that boundary).
pub struct CodeGraphState {
    inner: RwLock<Option<ProjectIndex>>,
    embedder: Mutex<Option<Embedder>>,
    parser_manager: parser::ParserManager,
    /// Coarse build progress for the frontend to poll (no app.emit — see memory:
    /// cross-thread emit park主线程). Updated from the build's spawn_blocking
    /// task; read by the synchronous `codegraph_build_progress` command. All
    /// `Relaxed`: these are approximate progress hints, not synchronization.
    build_active: AtomicBool,
    build_done: AtomicUsize,
    build_total: AtomicUsize,
    /// 当前阶段/文件的可读描述（"扫描文件树..." / "解析 src/foo.ts (123/456)"
    /// / "嵌入符号 1340/2000" / "写盘..."）。低频更新（每文件/每批一次），用
    /// Mutex 而非 atomic——poll 命令读时极短 lock，纯内存。
    build_current: Mutex<String>,
    /// 取消正在跑的 embed（close/切项目时置 true，embed 循环下一批 check 后 break）。
    /// 避免孤儿 embed 继续浪费 CPU 写一个已被 take 走的 shard。
    build_cancel: AtomicBool,
}

impl CodeGraphState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(None),
            embedder: Mutex::new(None),
            parser_manager: parser::ParserManager::new(),
            build_active: AtomicBool::new(false),
            build_done: AtomicUsize::new(0),
            build_total: AtomicUsize::new(0),
            build_current: Mutex::new(String::new()),
            build_cancel: AtomicBool::new(false),
        }
    }
}

/// Tauri command: build (or load) the full index for a project.
///
/// Two-phase so the **structure layer is ready before embed** finishes:
/// - Phase 1 (walk + parse + create shard + persist): swap `ProjectIndex` in
///   with `embed_ready=false`. goto-definition's structure layer (in-memory
///   `SymbolTable`) works **immediately** — users get exact cross-file jumps
///   without waiting for the slow ONNX embed.
/// - Phase 2 (embed the collected points into the shard in the background):
///   flip `embed_ready=true` when done, or break early if `build_cancel` is set
///   (close / project switch). Semantic search is gated on `embed_ready` to
///   avoid concurrent upsert+search on the same shard.
///
/// Heavy IO/CPU runs in `spawn_blocking` off the Tauri main thread. Load-or-
/// build: reuse a fresh on-disk index when available (embed already complete),
/// else full-rebuild.
#[tauri::command]
pub async fn codegraph_build_index(
    project_root: String,
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
) -> Result<serde_json::Value, String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);

        // Fast path: reuse fresh on-disk index (embed already complete).
        if let Some((table, shard)) = indexer::load_project_index(&root, &st.parser_manager) {
            let n = table.len();
            *st.inner.write().map_err(|e| e.to_string())? = Some(ProjectIndex {
                project_root: root,
                symbols: table,
                shard,
                indexed_at: SystemTime::now(),
                embed_ready: Arc::new(AtomicBool::new(true)),
            });
            return Ok(serde_json::json!({ "loaded": true, "total_symbols": n }));
        }

        // Ensure embedder (best-effort; structure layer works without it).
        let has_emb = {
            let mut emb = st.embedder.lock().map_err(|e| e.to_string())?;
            if emb.is_none() {
                match Embedder::new() {
                    Ok(e) => *emb = Some(e),
                    Err(e) => tracing::warn!("codegraph: embedder unavailable: {}", e),
                }
            }
            emb.is_some()
        };

        st.build_cancel.store(false, Ordering::Relaxed);
        st.build_active.store(true, Ordering::Relaxed);
        let on_status = |s: &str| {
            if let Ok(mut g) = st.build_current.lock() {
                g.clear();
                g.push_str(s);
            }
        };

        // Phase 1: collect symbols + create shard + persist. Returns points for Phase 2.
        let (table, shard, points, stats) = indexer::build_structure_index(
            &root,
            &st.parser_manager,
            Some(&on_status),
        )
        .map_err(|e| format!("Indexing failed: {}", e))?;

        // Swap structure layer in NOW (embed_ready=false). goto's structure layer
        // is immediately usable; semantic layer waits for Phase 2.
        let embed_ready = Arc::new(AtomicBool::new(false));
        let n = table.len();
        *st.inner.write().map_err(|e| e.to_string())? = Some(ProjectIndex {
            project_root: root,
            symbols: table,
            shard: shard.clone(),
            indexed_at: SystemTime::now(),
            embed_ready: embed_ready.clone(),
        });

        // Phase 2: embed the collected points into the shard (background fill).
        // Structure layer is already swapped in and serving goto; this only adds
        // the semantic layer. Cancelled by close/project switch via build_cancel.
        let total = points.len();
        st.build_total.store(total, Ordering::Relaxed);
        st.build_done.store(0, Ordering::Relaxed);
        on_status(&format!("嵌入符号 0/{}", total));
        let mut embedded = 0usize;
        if has_emb {
            let emb = st.embedder.lock().map_err(|e| e.to_string())?;
            if let Some(embedder) = emb.as_ref() {
                for chunk in points.chunks(256) {
                    if st.build_cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Err(e) = indexer::store::embed_and_store(chunk, embedder, &shard) {
                        tracing::warn!("codegraph: embed batch failed: {}", e);
                    }
                    embedded = embedded.saturating_add(chunk.len());
                    st.build_done.store(embedded, Ordering::Relaxed);
                    on_status(&format!("嵌入符号 {}/{}", embedded, total));
                }
            }
        }
        let completed = !st.build_cancel.load(Ordering::Relaxed) && embedded >= total;
        if completed {
            embed_ready.store(true, Ordering::Relaxed);
        }
        st.build_active.store(false, Ordering::Relaxed);
        if let Ok(mut g) = st.build_current.lock() {
            g.clear();
        }

        Ok(serde_json::json!({
            "loaded": false,
            "scanned_files": stats.scanned_files,
            "files_with_symbols": stats.files_with_symbols,
            "total_symbols": n,
            "has_embeddings": completed,
        }))
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

/// Tauri command: goto-definition query.
///
/// Structure layer (exact, cross-file) runs under a read lock; the shard Arc
/// is cloned out and the read lock is dropped BEFORE the semantic embed, so
/// an ONNX forward pass never blocks other readers. Runs in `spawn_blocking`.
#[tauri::command]
pub async fn codegraph_goto_definition(
    word: String,
    #[allow(unused_variables)] file: String,
    line: usize,
    #[allow(unused_variables)] column: usize,
    #[allow(unused_variables)] project_root: String,
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
) -> Result<Vec<types::QueryResult>, String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        // 1. structure (exact, cross-file) under a read lock; clone shard Arc out.
        let (structure, shard_arc, embed_ready) = {
            let guard = st.inner.read().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                None => return Ok(vec![]),
                Some(pi) => (
                    query::structure::structure_lookup(&word, &pi.symbols, line),
                    pi.shard.clone(),
                    pi.embed_ready.load(Ordering::Relaxed),
                ),
            }
        };
        if !structure.is_empty() {
            return Ok(structure);
        }
        // 2. semantic — only if embed has completed (embed_ready). While the
        // background embed is filling the shard, skip semantic to avoid
        // concurrent upsert (embed) + search (here) on the same shard, which
        // Qdrant Edge does not guarantee safe. Frontend falls back to grep.
        if !embed_ready {
            return Ok(vec![]);
        }
        // lock embedder, embed word, search shard (read lock already dropped).
        let emb = st.embedder.lock().map_err(|e| e.to_string())?;
        if let Some(embedder) = emb.as_ref() {
            match query::semantic::semantic_search(&word, embedder, &shard_arc, 10) {
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
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

/// Tauri command: close and flush the index for a project.
///
/// Optimizes the shard and drops the active index so its resources are
/// released. symbols.json / meta.json were already persisted at build time.
/// Runs in `spawn_blocking` (optimize may do disk IO).
#[tauri::command]
pub async fn codegraph_close(
    #[allow(unused_variables)] project_root: String,
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
) -> Result<(), String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        // Cancel any in-flight background embed so it stops at the next batch
        // instead of continuing to write an orphaned shard (the ProjectIndex we
        // take below). The embed task holds its own shard Arc, so the writes are
        // memory-safe even without cancellation — this just avoids wasting CPU.
        st.build_cancel.store(true, Ordering::Relaxed);
        if let Some(pi) = st.inner.write().map_err(|e| e.to_string())?.take() {
            if let Err(e) = pi.shard.optimize() {
                tracing::warn!("codegraph: optimize on close failed: {}", e);
            }
            // symbols.json / meta.json already persisted at build/reindex time.
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

/// Tauri command: incrementally re-index a single file after it is saved.
///
/// No-op if no index is built or the file's project does not match the active
/// index. Runs in `spawn_blocking`. The write lock is held for the whole
/// single-file reindex (drop stale → re-parse → embed → re-persist): this
/// serializes Qdrant shard access (concurrent `search` + `upsert` on the same
/// `Arc<CodeShard>` is not guaranteed safe), at the cost of briefly blocking
/// goto queries during the embed. For a typical file (tens of symbols) the
/// embed is well under 100ms; a pathologically large file could block for
/// longer. Acceptable for a save-triggered (non-hot) path — revisit if manual
/// E2E shows goto lag on save of large files.
#[tauri::command]
pub async fn codegraph_reindex_file(
    project_root: String,
    file: String,
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
) -> Result<(), String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);
        let abs = PathBuf::from(&file);

        // Only reindex if it belongs to the active project.
        let mut guard = st.inner.write().map_err(|e| e.to_string())?;
        let pi = match guard.as_mut() {
            Some(pi) if pi.project_root == root => pi,
            _ => return Ok(()),
        };
        // Skip while the background embed is still filling the shard — concurrent
        // upsert (embed) + upsert (reindex) on the same shard isn't guaranteed
        // safe by Qdrant Edge. The save-triggered change is picked up by the next
        // full rebuild (is_stale mtime check); skipping here is safe.
        if !pi.embed_ready.load(Ordering::Relaxed) {
            return Ok(());
        }
        let emb = st.embedder.lock().map_err(|e| e.to_string())?;
        // Clone the shard Arc out so reindex_one borrows &mut pi.symbols
        // without aliasing the shard reference.
        let shard = pi.shard.clone();
        indexer::reindex_one(
            &root,
            &abs,
            &mut pi.symbols,
            &shard,
            emb.as_ref(),
            &st.parser_manager,
        )
        .map_err(|e| format!("reindex failed: {}", e))
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

/// Tauri command: poll coarse build progress.
///
/// Pure atomic reads — no IO, no locks, no `spawn_blocking`. Intentionally a
/// synchronous inline command: per the project's freeze hardening, inline
/// sync commands that do纯内存 work never block the main thread. The frontend
/// polls this on a timer during a build instead of subscribing to `app.emit`
/// events — cross-thread emit was the root cause of历史 freeze (见 memory), so
/// progress is pulled by the frontend, never pushed from the backend.
///
/// Returns `{ active, done, total }`. `active=false` ⟹ idle (no build running
/// or build finished); the frontend treats `active && done<total` as "in
/// progress" and `!active` as "done/none" and stops polling.
#[tauri::command]
pub fn codegraph_build_progress(
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
) -> serde_json::Value {
    let current = state
        .build_current
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    // index_ready = a ProjectIndex is swapped in (structure layer usable for
    // exact goto) — true once Phase 1 finishes, even while the background embed
    // (Phase 2) is still running. Lets the UI tell the user "精确跳转已就绪".
    let index_ready = state.inner.read().map(|g| g.is_some()).unwrap_or(false);
    serde_json::json!({
        "active": state.build_active.load(Ordering::Relaxed),
        "done": state.build_done.load(Ordering::Relaxed),
        "total": state.build_total.load(Ordering::Relaxed),
        "current": current,
        "index_ready": index_ready,
    })
}