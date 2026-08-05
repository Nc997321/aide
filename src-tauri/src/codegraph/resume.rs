use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use crate::codegraph::build::{mark_embed_complete, reindex_files, run_embed_loop};
use crate::codegraph::guard;
use crate::codegraph::indexer;
use crate::codegraph::state::{CodeGraphState, ProjectIndex};
use crate::codegraph::types;

/// Attempt to RESUME an interrupted embed instead of full-rebuilding. Applies
/// when a previous build persisted the structure layer but died mid-embed
/// (`meta.embed_complete=false` — the old behavior rejected such an index in
/// every loader, forcing a full rebuild on every relaunch after an interrupt):
/// load the partial shard + per-file checkpoint, re-parse for fresh points,
/// embed only the files not yet done, then refresh files changed since the
/// interrupted build. Returns None when there's no resumable base → the caller
/// falls back to a full rebuild.
pub(crate) fn try_resume_embed(
    st: &std::sync::Arc<CodeGraphState>,
    root: &std::path::Path,
    model_name: &str,
    dim: usize,
    has_emb: bool,
) -> Result<Option<serde_json::Value>, String> {
    if !has_emb || dim == 0 {
        return Ok(None); // can't embed → resume pointless; full rebuild (structure-only)
    }
    let base = indexer::index_dir(root);
    let Some((table_stale, _edges_stale, shard, meta, checkpoint)) =
        indexer::load_resume_base(root, model_name, dim)
    else {
        return Ok(None);
    };
    let skipped_files = checkpoint.files.len();
    tracing::info!(
        "codegraph: resuming interrupted embed ({} files already embedded, shard {})",
        skipped_files,
        meta.shard_dir
    );

    // Files changed since the interrupted build: the fresh re-parse below picks
    // up their new structure, but their OLD vectors may still be in the shard
    // and they may sit in the checkpoint as done. Exclude them from the skip
    // set and reindex them per-file after the embed completes (refreshes
    // vectors + re-persists symbols.json/meta). Best-effort delete of their
    // stale points now — delete errors on a half-built shard are caught inside
    // CodeShard and surface as Err (logged, not fatal).
    let exts = st.parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = exts.iter().copied().collect();
    let (changed, _total_files) = indexer::changed_files_since(root, &ext_refs, meta.indexed_at);
    let mut skip = checkpoint.files.clone();
    for abs in &changed {
        let rel = abs
            .strip_prefix(root)
            .unwrap_or(abs)
            .to_string_lossy()
            .replace('\\', "/");
        skip.insert(rel.clone());
        if checkpoint.files.contains(&rel) {
            if let Err(e) = shard.delete_by_file(&rel) {
                tracing::warn!("codegraph: resume stale-point delete failed {}: {}", rel, e);
            }
        }
    }

    st.build_cancel.store(false, Ordering::Relaxed);
    st.build_active.store(true, Ordering::Relaxed);
    let on_status = |s: &str| {
        if let Ok(mut g) = st.build_current.lock() {
            g.clear();
            g.push_str(s);
        }
    };

    // Re-walk + re-parse for fresh points (Phase 1 cost only — no new shard).
    // The freshly-parsed structure layer (not the stale symbols.json one) is
    // swapped in below: it already reflects files changed since the interrupt.
    let (table, edges, points, _stats) = match indexer::collect_symbols(
        root,
        &st.parser_manager,
        Some(&on_status),
        Some(&st.build_cancel),
    ) {
        Ok(x) => x,
        Err(e) => {
            st.build_active.store(false, Ordering::Relaxed);
            return Err(format!("Indexing failed: {}", e));
        }
    };
    let points: Vec<types::IndexedPoint> = points
        .into_iter()
        .filter(|p| !skip.contains(&p.symbol.file))
        .collect();

    // Swap the resumed index in (embed_ready=false until the loop completes).
    let embed_ready = Arc::new(AtomicBool::new(false));
    let new_index = ProjectIndex {
        project_root: root.to_path_buf(),
        symbols: table,
        edges,
        shard: shard.clone(),
        indexed_at: SystemTime::now(),
        embed_ready: embed_ready.clone(),
    };
    let old = guard::swap_returning_old(&st.inner, new_index);
    guard::drop_catching_panics(old, "old project index (resume swap)");

    let total = points.len();
    st.build_total.store(total, Ordering::Relaxed);
    st.build_done.store(0, Ordering::Relaxed);
    on_status(&format!("建立索引 0/{}", total));
    let outcome = run_embed_loop(st, &base, &meta.shard_dir, &shard, &points, checkpoint.files, &on_status)?;
    let embedded = outcome.embedded;
    let skipped = outcome.skipped;
    let processed = embedded + skipped;
    let completed = !outcome.cancelled && outcome.ran
        && !outcome.stopped_early
        && outcome.batch_errors == 0
        && processed >= total;
    if completed {
        embed_ready.store(true, Ordering::Relaxed);
        // Flush in-memory vectors to disk BEFORE marking embed_complete (same
        // reason as the fresh-build path): without this a restart loads an empty
        // shard and full-rebuilds every time.
        if let Err(e) = shard.flush() {
            tracing::warn!("codegraph: shard flush on resume complete failed: {}", e);
        }
        mark_embed_complete(root, &meta.shard_dir);
        if !changed.is_empty() {
            let (rescanned, errors) = reindex_files(st, root, &changed, model_name, dim)?;
            tracing::info!(
                "codegraph: resume changed-file refresh: {} reindexed, {} errors",
                rescanned,
                errors
            );
        }
    }
    let n = {
        let g = st.inner.read().map_err(|e| e.to_string())?;
        g.as_ref()
            .map(|pi| pi.symbols.len())
            // inner may have been taken by a `codegraph_close` of this workspace
            // (e.g. user switched away mid-resume) — fall back to the on-disk
            // symbols.json count we loaded, so total_symbols isn't reported 0.
            .unwrap_or_else(|| table_stale.len())
    };
    st.build_active.store(false, Ordering::Relaxed);
    if let Ok(mut g) = st.build_current.lock() {
        g.clear();
    }
    let embed_status = if completed {
        if skipped > 0 {
            format!(
                "ok (resumed, {} embedded, {} skipped, {} failed)",
                embedded, skipped, outcome.batch_errors
            )
        } else {
            "ok (resumed)".to_string()
        }
    } else if outcome.cancelled {
        format!(
            "cancelled at {}/{} ({} skipped, {} failed)",
            processed, total, skipped, outcome.batch_errors
        )
    } else if outcome.batch_errors > 0 {
        let first = outcome
            .first_err
            .as_ref()
            .map(|e| format!(" — first: {}", e))
            .unwrap_or_default();
        if outcome.stopped_early {
            format!(
                "batch_errors: {} (stopped early, embedded {}/{}, {} skipped){}",
                outcome.batch_errors, processed, total, skipped, first
            )
        } else {
            format!(
                "batch_errors: {} (embedded {}/{}, {} skipped){}",
                outcome.batch_errors, processed, total, skipped, first
            )
        }
    } else {
        format!(
            "incomplete: embedded {}/{} ({} skipped)",
            processed, total, skipped
        )
    };
    Ok(Some(serde_json::json!({
        "loaded": false,
        "resumed": true,
        "skipped_embedded_files": skipped_files,
        "total_symbols": n,
        "has_embeddings": completed,
        "embed_status": embed_status,
        "skipped_count": skipped,
        "failed_count": outcome.batch_errors,
        "shard_point_count": shard.point_count(),
        "embed_complete": completed,
        "health": crate::codegraph::build::build_health(true, completed, skipped, outcome.batch_errors),
    })))
}