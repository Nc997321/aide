use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use crate::codegraph::build::reindex_files;
use crate::codegraph::guard;
use crate::codegraph::indexer;
use crate::codegraph::state::{CodeGraphState, ProjectIndex};

/// Attempt an incremental reindex: if a compatible on-disk index exists and
/// only a small set of files changed since its `indexed_at`, load the old
/// index as a base and reindex just the changed files (fast) instead of
/// rebuilding from scratch. Returns `Some(build-result JSON)` on a successful
/// incremental update, or `None` when a full rebuild is required (no reusable
/// base, model/dim mismatch, or too many files changed). Called by
/// `codegraph_build_index` after the strict reuse path fails.
pub(crate) fn try_incremental_build(
    st: &std::sync::Arc<CodeGraphState>,
    root: &std::path::Path,
    model_name: &str,
    dim: usize,
) -> Result<Option<serde_json::Value>, String> {
    // 1. Load a compatible on-disk index, IGNORING staleness. None → no
    //    reusable base (no meta / model·dim mismatch / unloadable) → full rebuild.
    let (table, edges, shard, meta) = match indexer::load_compatible_index(root, model_name, dim) {
        Some(x) => x,
        None => return Ok(None),
    };
    // 2. Find changed files + total (one walk).
    let exts = st.parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = exts.iter().copied().collect();
    let (changed, total) = indexer::changed_files_since(root, &ext_refs, meta.indexed_at);
    // 3. Threshold: too many changes → a clean full rebuild is faster and
    //    avoids reusing a possibly-dirty old shard.
    if !indexer::decide_increment(changed.len(), total) {
        return Ok(None);
    }
    // 4. Swap the old index in (embed_ready=true, reusing the old vectors).
    let embed_ready = Arc::new(AtomicBool::new(true));
    let new_index = ProjectIndex {
        project_root: root.to_path_buf(),
        symbols: table,
        edges,
        shard: shard.clone(),
        indexed_at: SystemTime::now(),
        embed_ready: embed_ready.clone(),
    };
    let old = guard::swap_returning_old(&st.inner, new_index);
    guard::drop_catching_panics(old, "old project index (incremental swap)");
    // 5. Reindex each changed file (per-file write lock). `reindex_one`
    //    re-persists symbols.json + meta.json (indexed_at=now) on each file,
    //    so disk stays in sync with the live table.
    st.build_cancel.store(false, Ordering::Relaxed);
    let (rescanned, errors) = reindex_files(st, root, &changed, model_name, dim)?;
    let cancelled = st.build_cancel.load(Ordering::Relaxed);
    let n = {
        let g = st.inner.read().map_err(|e| e.to_string())?;
        g.as_ref()
            .map(|pi| pi.symbols.len())
            // inner may have been taken by a `codegraph_close` (workspace switch
            // mid-reindex) — fall back to the on-disk meta symbol_count so
            // total_symbols isn't reported 0.
            .unwrap_or(meta.symbol_count)
    };
    let status = format!(
        "incremental ({} reindexed{}{})",
        rescanned,
        if errors > 0 {
            format!(", {} errors", errors)
        } else {
            String::new()
        },
        if cancelled { ", cancelled" } else { "" }
    );
    // Flush reindexed vectors to disk so a restart sees them (otherwise the
    // new/changed files' vectors live in memory only and are lost on restart).
    if let Err(e) = shard.flush() {
        tracing::warn!("codegraph: shard flush on incremental complete failed: {}", e);
    }
    Ok(Some(serde_json::json!({
        "loaded": false,
        "incremental": true,
        "rescanned_files": rescanned,
        "total_symbols": n,
        "has_embeddings": true,
        "embed_status": status,
        "skipped_count": 0,
        "failed_count": 0,
        "shard_point_count": shard.point_count(),
        "embed_complete": true,
        "health": "complete",
    })))
}