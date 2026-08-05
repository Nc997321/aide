use std::path::PathBuf;
use std::sync::atomic::Ordering;

use crate::codegraph::embed::Embedder;
use crate::codegraph::embed_config::query_score_threshold;
use crate::codegraph::guard;
use crate::codegraph::indexer;
use crate::codegraph::query;
use crate::codegraph::state::CodeGraphState;

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
    settings_service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<Vec<crate::codegraph::types::QueryResult>, String> {
    let st = state.inner().clone();
    let ss = settings_service.inner().clone();
    tokio::task::spawn_blocking(move || {
        // 1. structure (exact, cross-file) under a read lock; clone shard Arc out
        // atomically with embed_ready (TOCTOU: reading them under separate locks
        // could swap in a mid-embed shard after we passed the embed_ready gate).
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
            match query::semantic::semantic_search(&word, embedder.as_ref(), &shard_arc, 10, query_score_threshold(&ss)) {
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
            guard::drop_catching_panics(pi, "old project index (close)");
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

/// Tauri command: incrementally re-index a single file after it is saved.
///
/// Returns a structured status so the frontend can tell what happened (the
/// save path used to be fully silent — three no-op gates + the frontend's
/// `.catch(()=>{})` swallowed success AND failure, so "保存后没有任何反应"
/// was true whether it updated, skipped, or errored). Possible results:
///   `{ "reindexed": true }`                       — file re-parsed + re-embedded
///   `{ "reindexed": false, "skipped": "..." }`    — no-op, with the reason:
///       `no_active_index`  — no index in memory (not built yet / closed)
///       `not_in_project`   — active index is for a different project root
///       `embed_not_ready`  — background embed still running (or stopped early,
///                            e.g. bge-m3 NaN — semantic layer incomplete); the
///                            save change is picked up by the next full rebuild
///   `Err(...)`                                    — reindex ran but failed
///
/// No-op gates return `Ok({reindexed:false, skipped})` (NOT a silent `Ok(())`)
/// so the caller can surface the reason. Runs in `spawn_blocking`. The write
/// lock is held for the whole single-file reindex (drop stale → re-parse →
/// embed → re-persist): this serializes Qdrant shard access (concurrent
/// `search` + `upsert` on the same `Arc<CodeShard>` is not guaranteed safe),
/// at the cost of briefly blocking goto queries during the embed. For a
/// typical file (tens of symbols) the embed is well under 100ms.
#[tauri::command]
pub async fn codegraph_reindex_file(
    project_root: String,
    file: String,
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
) -> Result<serde_json::Value, String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);
        let abs = PathBuf::from(&file);

        // 受信任工作区门控：不信任则跳过 reindex（索引本就不该存在）。
        if !crate::commands::workspace::is_path_trusted(&project_root) {
            return Ok(serde_json::json!({ "reindexed": false, "skipped": "untrusted" }));
        }

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
                return Ok(serde_json::json!({ "reindexed": false, "skipped": "not_in_project" }));
            }
            None => {
                tracing::info!(
                    "codegraph: save reindex skipped (no_active_index) file={}",
                    abs.display()
                );
                return Ok(serde_json::json!({ "reindexed": false, "skipped": "no_active_index" }));
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
            return Ok(serde_json::json!({ "reindexed": false, "skipped": "embed_not_ready" }));
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
        let embedder_ref: Option<&dyn Embedder> = emb.as_ref().map(|b| b.as_ref());
        // Clone the shard Arc out so reindex_one borrows &mut pi.symbols
        // without aliasing the shard reference.
        let shard = pi.shard.clone();
        indexer::reindex_one(
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
        Ok(serde_json::json!({ "reindexed": true }))
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

/// Tauri command: incrementally rescan changed files (manual「更新索引」button).
///
/// Walks the project, finds source files with mtime > the index's `indexed_at`,
/// and reindexes only those via `reindex_one` (drop stale symbols → re-parse →
/// re-embed that file). Unchanged files keep their existing symbols/vectors —
/// this is the "hot reload" path, fast when only a few files changed (edited in
/// an external editor, or `git pull` brought new code).
///
/// No-op if no index is built, the root doesn't match, or the background embed
/// hasn't finished (embed_ready=false — the build will pick up changes via the
/// next full rebuild's is_stale check). Runs in `spawn_blocking`; per-file write
/// locks are released between files so goto queries can interleave.
#[tauri::command]
pub async fn codegraph_rescan(
    project_root: String,
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
) -> Result<serde_json::Value, String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);
        // 受信任工作区门控：不信任则跳过 rescan。
        if !crate::commands::workspace::is_path_trusted(&project_root) {
            return Ok(serde_json::json!({
                "active_index": false,
                "rescanned_files": 0,
                "skipped": "untrusted",
            }));
        }
        // Snapshot indexed_at + embed_ready under a read lock; bail if no index
        // or the active index is for a different root.
        let indexed_at = {
            let guard = st.inner.read().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                None => {
                    return Ok(serde_json::json!({
                        "active_index": false,
                        "rescanned_files": 0,
                    }));
                }
                Some(pi) => {
                    if pi.project_root != root {
                        return Ok(serde_json::json!({
                            "active_index": false,
                            "rescanned_files": 0,
                        }));
                    }
                    if !pi.embed_ready.load(Ordering::Relaxed) {
                        return Ok(serde_json::json!({
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
        let ext_refs: Vec<&str> = exts.iter().copied().collect();
        let files = indexer::walk::walk_source_files(&root, &ext_refs);
        let changed: Vec<PathBuf> = files
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
            let embedder_ref: Option<&dyn Embedder> = emb.as_ref().map(|b| b.as_ref());
            let shard = pi.shard.clone();
            match indexer::reindex_one(
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

        Ok(serde_json::json!({
            "active_index": true,
            "embed_ready": true,
            "changed_files": changed.len(),
            "rescanned_files": rescanned,
            "errors": errors,
        }))
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