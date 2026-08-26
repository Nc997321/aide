use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use crate::codegraph::embed::Embedder;
use crate::codegraph::embed_config::{config_embedder_identity, load_embedder_config, make_embedder};
use crate::codegraph::guard;
use crate::codegraph::incremental::try_incremental_build;
use crate::codegraph::indexer;
use crate::codegraph::meta::Meta;
use crate::codegraph::resume::try_resume_embed;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::state::{CodeGraphState, ProjectIndex};
use crate::codegraph::types;

use super::EMBED_BATCH_SIZE;

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
/// Embedder backend is read from the app config (`settings.codegraphEmbedder`)
/// on every build; a config change (backend / model / dim) drops the cached
/// embedder and forces a full rebuild because the on-disk meta won't match.
///
/// Heavy IO/CPU runs in `spawn_blocking` off the Tauri main thread. Load-or-
/// build: reuse a fresh on-disk index when available (embed already complete),
/// else full-rebuild. `force = true` skips the fast path and full-rebuilds
/// unconditionally (manual「全量重建」button).
#[tauri::command]
pub async fn codegraph_build_index(
    project_root: String,
    force: Option<bool>,
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
    settings_service: tauri::State<'_, std::sync::Arc<crate::settings::SettingsService>>,
) -> Result<serde_json::Value, String> {
    let force = force.unwrap_or(false);
    let st = state.inner().clone();
    let settings_service = settings_service.inner().clone();
    tokio::task::spawn_blocking(move || {
        // 命令级门控：不信任 / 总开关关闭则不建/不重建索引。索引不存在时
        // find_symbol / call_graph / semantic_search / goto_definition 自然返回
        // no_index 优雅降级。
        if let Some(reason) = crate::codegraph::gate::skip_reason(
            crate::commands::workspace::is_path_trusted(&project_root),
            &settings_service,
        ) {
            return Ok(serde_json::json!({
                "loaded": false,
                "skipped": reason,
                "total_symbols": 0,
                "scanned_files": 0,
                "files_with_symbols": 0,
            }));
        }
        let root = PathBuf::from(&project_root);
        // 已信任工作区激活索引：顺带确保该仓库 exclude 忽略 `.aide/`——覆盖
        // 历史已信任的工作区（trust_workspace 只在「新信任」那一刻生效）。
        // 幂等、失败仅记日志；每次工作区激活多一次 git rev-parse（blocking
        // 池内几十 ms），可忽略。
        crate::commands::workspace::ensure_aide_excluded(&root);
        // 家目录/磁盘根这类非项目 root 不再需要特例守卫：展示与索引的入口
        // （get_project_info → FileTree/ensureIndex）已显式区分「无工作区」，
        // 不会把家目录传进来；任何其它误开的超大目录由 walk 后的
        // MAX_INDEX_FILES 保险丝统一拒建（见 indexer::file_count_error）。
        // Cancel any in-flight build from a previous workspace/config switch and
        // wait for it to drain before starting the new one. Without this, the old
        // spawn_blocking task keeps running — its closure holds the old shard Arc +
        // collected points + embedder, and switching workspaces mid-build
        // accumulates concurrent builds = memory leak (RSS climbs with each switch
        // and never fully drops, because the old Phase 2 loop checks `build_cancel`
        // but the new build reset it to false). The old task checks `build_cancel`
        // each Phase 2 batch AND each Phase 1 file (collect_symbols), so it drains
        // quickly once cancelled. The 10s cap guards against a stuck old task
        // blocking the new build indefinitely; normally Phase 1 observes the cancel
        // within a few files and exits well under that.
        st.build_cancel.store(true, Ordering::Relaxed);
        let wait_deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while st.build_active.load(Ordering::Relaxed) && std::time::Instant::now() < wait_deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        st.build_cancel.store(false, Ordering::Relaxed);
        // Mark the build active for the WHOLE command (not just Phase 2 / resume):
        // the frontend polls build_active to show the file-tree progress bar, and
        // the try_incremental / try_resume preflight phases (walk + parse) take
        // long enough that the first 500ms poll would otherwise see active=false
        // and stop the poll — the build looks like "nothing happened". Fast-path
        // reuse / incremental hit reset it to false before returning; try_resume
        // and the full build manage it themselves.
        st.build_active.store(true, Ordering::Relaxed);
        let cfg = load_embedder_config(&settings_service);
        // Cheap pre-construction identity implied by the config (backend + model
        // + configured dim). Used to decide whether the *cached* embedder is still
        // valid without constructing a new one — constructing fastembed loads the
        // ONNX model, which we avoid when the config hasn't changed.
        let want_id = config_embedder_identity(&cfg);

        // Ensure the cached embedder matches the config; (re)create if missing or
        // if the cached identity differs from what the config implies. After
        // (re)creation, cache the embedder's *authoritative* identity (read via the
        // trait methods) so the cache is the single source of truth, not the
        // estimate — for http with dim=0 (auto-probe) this caches dim 0 until the
        // probe resolves the real dim below.
        // `embed_status` captures the exact reason embed didn't complete, surfaced
        // in the build result JSON so the frontend can show it without relying on
        // tracing logs (which may be filtered by RUST_LOG or scrolled off).
        let mut embed_status = String::new();
        let has_emb = {
            let mut emb = st.embedder.lock().map_err(|e| e.to_string())?;
            let mut emb_model = st.embedder_model.lock().map_err(|e| e.to_string())?;
            let needs_recreate = match emb_model.as_ref() {
                None => true,
                Some(id) => *id != want_id,
            };
            if needs_recreate {
                *emb = None;
                match make_embedder(&cfg) {
                    Ok(e) => {
                        *emb_model = Some((e.model_name().to_string(), e.dim()));
                        *emb = Some(e);
                    }
                    Err(e) => {
                        tracing::warn!("codegraph: embedder unavailable: {}", e);
                        embed_status = format!("no_embedder: {}", e);
                        *emb_model = None;
                    }
                }
            }
            emb.is_some()
        };

        // Read the authoritative identity from the cache (populated above from the
        // trait methods). Resolve the effective dim: fastembed → 384 (constant);
        // http configured dim → that value; http dim=0 (auto-probe) → must probe
        // with one embed call before building the shard, since the shard is sized
        // to a fixed dim.
        let (model_name, mut dim) = st
            .embedder_model
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .unwrap_or_else(|| (String::new(), 0));
        if has_emb && dim == 0 {
            // Auto-probe: embed a single sentinel text to learn the dimension.
            // Done under the embedder lock; on failure we log and fall back to no
            // embedder (structure layer still works).
            let probe = {
                let emb = st.embedder.lock().map_err(|e| e.to_string())?;
                match emb.as_ref() {
                    Some(e) => crate::codegraph::embed::embed_one(e.as_ref(), "probe"),
                    None => Ok(Vec::new()),
                }
            };
            match probe {
                Ok(v) if !v.is_empty() => {
                    dim = v.len();
                    // Lock in the probed dim in the cache so subsequent builds
                    // reuse the embedder (cache identity now matches the real dim).
                    if let Ok(mut emb_model) = st.embedder_model.lock() {
                        *emb_model = Some((model_name.clone(), dim));
                    }
                }
                Ok(_) => {
                    tracing::warn!("codegraph: embedder probe returned empty vector");
                    embed_status = "probe_empty".to_string();
                }
                Err(e) => {
                    tracing::warn!("codegraph: embedder probe failed: {}", e);
                    embed_status = format!("probe_failed: {}", e);
                }
            }
        }

        // Reuse paths: only when NOT force (manual 全量重建 skips them ALL —
        // force means the user explicitly wants a from-scratch rebuild, so we
        // don't try to reuse / incrementally update / resume; straight to a full
        // rebuild, which is what "全量重建" promises).
        if !force {
            // Fast path: reuse fresh on-disk index whose meta matches this embedder
            // (model_name + dim). A backend/model/dim switch won't match → full rebuild.
            if let Some((table, edges, shard)) =
                indexer::load_project_index(&root, &st.parser_manager, &model_name, dim)
            {
                let n = table.len();
                *st.inner.write().map_err(|e| e.to_string())? = Some(ProjectIndex {
                    project_root: root,
                    symbols: table,
                    edges,
                    shard,
                    indexed_at: SystemTime::now(),
                    embed_ready: Arc::new(AtomicBool::new(true)),
                });
                st.build_active.store(false, Ordering::Relaxed);
                return Ok(serde_json::json!({
                    "loaded": true,
                    "total_symbols": n,
                    "embed_complete": true,
                    "health": "complete",
                }));
            }
            // Strict reuse failed (stale / no index / model mismatch). Before
            // falling back to a full rebuild, try an INCREMENTAL update: if a
            // compatible old index exists and only a few files changed, reindex just
            // those instead of rebuilding the whole project. Returns Some(result) on
            // a successful incremental, None when a full rebuild is required.
            if let Some(json) = try_incremental_build(&st, &root, &model_name, dim)? {
                st.build_active.store(false, Ordering::Relaxed);
                return Ok(json);
            }
            // Incremental didn't apply. Before falling back to a full rebuild, try
            // RESUMING an interrupted embed: a previous build finished Phase 1
            // (structure layer persisted) but was cancelled/killed mid-embed, so
            // meta.embed_complete=false poisoned every loader into full-rebuild.
            // With the per-file embed checkpoint we re-embed only the remaining
            // files — an interrupted 4-minute embed resumes in seconds instead of
            // restarting from scratch on every app relaunch. (try_resume_embed
            // manages build_active itself; no reset needed here.)
            if let Some(json) = try_resume_embed(&st, &root, &model_name, dim, has_emb)? {
                return Ok(json);
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

        // Orphan shard-dir cleanup for THIS project. Safe to remove leftover
        // `qdrant-*` dirs under this project's index dir when no live CodeShard
        // references this project's index dir — i.e. when `inner` is None (fresh
        // process) OR holds a DIFFERENT project (workspace switch: the live
        // CodeShard belongs to the other project's index_dir, so this project's
        // qdrant-* orphans are referenced by nothing live). We keep the
        // meta-pointed dir as a conservative fallback (if this rebuild fails, the
        // old index remains loadable on next start — though stale, it's not gone).
        //
        // Skip only on SAME-project rebuild: the old shard is still live (its
        // Arc is in inner + maybe goto clones), so its dir must not be touched.
        // That orphan is cleaned the next time the user switches away and back
        // (then `same_project_live` is false and cleanup runs).
        //
        // History: the original condition was `inner.is_none()`, which only fired
        // on the very first build of a process. Workspace switching always left
        // `inner` Some (the previous project's index), so cleanup never ran and
        // orphan shard dirs accumulated across every switch — observed as two
        // (or more) `qdrant-*` dirs per project, the older ones orphaned and
        // never reclaimed. Tracking `same_project_live` instead fires cleanup
        // on every workspace switch too, since the switched-to project's index
        // dir holds no live CodeShard.
        let same_project_live = st
            .inner
            .read()
            .ok()
            .and_then(|g| g.as_ref().map(|pi| pi.project_root == root))
            .unwrap_or(false);
        if !same_project_live {
            let base = indexer::index_dir(&root);
            let keep = Meta::load(&base.join("meta.json"))
                .map(|m| m.shard_dir)
                .unwrap_or_else(|| "qdrant".to_string());
            indexer::cleanup_orphan_shard_dirs(&base, &keep);
        }

        // Phase 1: collect symbols + create shard + persist. Returns points for Phase 2.
        // If dim is still 0 (no embedder + auto-probe never resolved), we can't size
        // a shard — skip semantic layer entirely (structure layer still built).
        let can_embed = has_emb && dim > 0;
        let build_dim = if can_embed { dim } else { 384 };
        let (table, edges, shard, points, stats) = indexer::build_structure_index(
            &root,
            &st.parser_manager,
            build_dim,
            &model_name,
            Some(&on_status),
            Some(&st.build_cancel),
        )
        .map_err(|e| format!("Indexing failed: {}", e))?;

        // Swap structure layer in NOW (embed_ready=false). goto's structure layer
        // is immediately usable; semantic layer waits for Phase 2.
        let embed_ready = Arc::new(AtomicBool::new(false));
        let n = table.len();
        let new_index = ProjectIndex {
            // `root` is cloned (not moved) so it stays usable in the Phase 2
            // completion block below to re-save `meta.json` with
            // `embed_complete: true`. One PathBuf clone per build — negligible.
            project_root: root.clone(),
            symbols: table,
            edges,
            shard: shard.clone(),
            indexed_at: SystemTime::now(),
            embed_ready: embed_ready.clone(),
        };
        // Lock-safe swap: the OLD index (if any) is returned and dropped
        // OUTSIDE the write lock with panic guarding. A Qdrant EdgeShard
        // drop-time flush panic (segment temp files missing — os error 3,
        // e.g. after antivirus scan / orphan cleanup) used to poison `inner`
        // here, making every subsequent build return
        // "poisoned lock: another task failed inside" until process restart.
        let old_index = guard::swap_returning_old(&st.inner, new_index);
        guard::drop_catching_panics(old_index, "old project index (build swap)");

        // Reclaim the OLD shard dir now that it's swapped out. Before this, a
        // full rebuild left the previous qdrant-* dir as an orphan under
        // .aide/index/: meta now points at the new shard_dir (written in Phase 1
        // above), so the old dir is unreferenced, but the pre-Phase-1 cleanup
        // skipped it (same_project_live=true — the old shard was still live in
        // `inner`). The old shard's Arc is dropped just above; any goto clones
        // still holding it will catch their own flush panic on drop.
        {
            let base = indexer::index_dir(&root);
            let keep = Meta::load(&base.join("meta.json"))
                .map(|m| m.shard_dir)
                .unwrap_or_default();
            indexer::cleanup_orphan_shard_dirs(&base, &keep);
        }

        // Phase 2: embed the collected points into the shard (background fill).
        // Structure layer is already swapped in and serving goto; this only adds
        // the semantic layer. Cancelled by close/project switch via build_cancel.
        // Per-file progress is checkpointed to disk so an interrupted embed can
        // RESUME on the next build (try_resume_embed) instead of full-rebuilding.
        let total = points.len();
        st.build_total.store(total, Ordering::Relaxed);
        st.build_done.store(0, Ordering::Relaxed);
        on_status(&format!("建立索引 0/{}", total));
        let base = indexer::index_dir(&root);
        let shard_dir = Meta::load(&base.join("meta.json"))
            .map(|m| m.shard_dir)
            .unwrap_or_default();
        // Belt-and-suspenders: reset cancel right before Phase 2. A concurrent
        // close of the previous workspace can set build_cancel during Phase 1
        // (walk+parse) — re-set here so the new build's embed isn't born
        // cancelled at 0/total.
        st.build_cancel.store(false, Ordering::Relaxed);
        let outcome = if can_embed {
            run_embed_loop(
                &st,
                &base,
                &shard_dir,
                &shard,
                &points,
                std::collections::HashSet::new(),
                &on_status,
            )?
        } else {
            EmbedRunOutcome::skipped()
        };
        let cancelled = outcome.cancelled;
        let embedded = outcome.embedded;
        let skipped = outcome.skipped;
        let processed = embedded + skipped;
        let completed = !cancelled && can_embed
            && !outcome.stopped_early
            && outcome.batch_errors == 0
            && processed >= total;
        if completed {
            embed_ready.store(true, Ordering::Relaxed);
            // Flush in-memory vectors to disk BEFORE marking embed_complete.
            // Without this, vectors live in memory only — a restart loads an
            // empty shard (point_count=0), the point_count sanity check rejects
            // it as broken, and every restart full-rebuilds. This is the fix for
            // the "restart always full-rebuilds" bug.
            if let Err(e) = shard.flush() {
                tracing::warn!("codegraph: shard flush on build complete failed: {}", e);
            }
            // Mark the on-disk meta as embed-complete (and drop the resume
            // checkpoint). Phase 1 wrote `embed_complete: false`; without
            // flipping it here the shard would be rejected on every reuse
            // (load_project_index / load_compatible_index gate on it), forcing
            // a pointless full rebuild next time. Re-reads the meta written in
            // Phase 1 — avoids duplicating Meta construction / shard_dir. The
            // shard_dir guard in mark_embed_complete prevents flipping the
            // wrong shard's flag if the meta was rewritten by another build.
            mark_embed_complete(&root, &shard_dir);
        }
        // Fill embed_status with the precise reason if embed didn't complete.
        if embed_status.is_empty() {
            if !can_embed {
                embed_status = if !has_emb {
                    "no_embedder".to_string()
                } else {
                    format!("dim_unresolved (dim={})", dim)
                };
            } else if cancelled {
                embed_status = format!(
                    "cancelled at {}/{} ({} skipped, {} failed)",
                    processed, total, skipped, outcome.batch_errors
                );
            } else if outcome.batch_errors > 0 {
                let first = outcome
                    .first_err
                    .as_ref()
                    .map(|e| format!(" — first: {}", e))
                    .unwrap_or_default();
                let why = if outcome.stopped_early {
                    format!(
                        "batch_errors: {} (stopped early, embedded {}/{}, {} skipped){}",
                        outcome.batch_errors, processed, total, skipped, first
                    )
                } else {
                    format!(
                        "batch_errors: {} (embedded {}/{}, {} skipped){}",
                        outcome.batch_errors, processed, total, skipped, first
                    )
                };
                embed_status = why;
            } else if !completed {
                embed_status = format!(
                    "incomplete: embedded {}/{} ({} skipped)",
                    processed, total, skipped
                );
            } else if skipped > 0 {
                embed_status = format!(
                    "ok ({} embedded, {} skipped, {} failed)",
                    embedded, skipped, outcome.batch_errors
                );
            } else {
                embed_status = "ok".to_string();
            }
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
            "embed_status": embed_status,
            "skipped_count": skipped,
            "failed_count": outcome.batch_errors,
            "shard_point_count": shard.point_count(),
            "embed_complete": completed,
            "health": build_health(can_embed, completed, skipped, outcome.batch_errors),
        }))
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}

/// Outcome of a Phase 2 embed run (fresh build or resume). `ran` is false when
/// no embedder was available — the caller distinguishes "didn't run" from
/// "ran but was cancelled / failed early".
pub(crate) struct EmbedRunOutcome {
    pub(crate) embedded: usize,
    pub(crate) skipped: usize,
    pub(crate) batch_errors: usize,
    pub(crate) first_err: Option<String>,
    pub(crate) stopped_early: bool,
    pub(crate) cancelled: bool,
    pub(crate) ran: bool,
}

impl EmbedRunOutcome {
    pub(crate) fn skipped() -> Self {
        Self { embedded: 0, skipped: 0, batch_errors: 0, first_err: None, stopped_early: false, cancelled: false, ran: false }
    }
}

/// Shared Phase 2 embed loop (fresh build + resume): batches points through the
/// cached embedder into the shard, updating build progress and checkpointing
/// per-file completion to `embed_checkpoint.json` so an interruption (app close
/// / workspace switch / kill) can resume next build instead of full-rebuilding.
///
/// `checkpoint_files` seeds the done-set (empty for a fresh build, loaded from
/// disk for a resume); files whose points complete during this run are added.
/// Saved every 8 batches and once at every exit (complete / cancelled / early
/// stop) — a kill loses at most a handful of batches of progress.
///
/// Batch-failure policy: tolerate a single transient failure, stop after 2
/// consecutive — a server-side fault (Ollama down / model unloaded) does not
/// recover by retrying every batch.
pub(crate) fn run_embed_loop(
    st: &CodeGraphState,
    base: &std::path::Path,
    shard_dir: &str,
    shard: &CodeShard,
    points: &[types::IndexedPoint],
    mut checkpoint_files: std::collections::HashSet<String>,
    on_status: &dyn Fn(&str),
) -> Result<EmbedRunOutcome, String> {
    let mut out = EmbedRunOutcome {
        embedded: 0,
        skipped: 0,
        batch_errors: 0,
        first_err: None,
        stopped_early: false,
        cancelled: false,
        ran: false,
    };
    let total = points.len();
    // Precompute contiguous per-file runs (collect_symbols emits all of a
    // file's points together): (file, index of its last point). After each
    // batch, every run whose last point is behind the cursor is fully embedded.
    let mut runs: Vec<(&str, usize)> = Vec::new();
    for (i, p) in points.iter().enumerate() {
        match runs.last_mut() {
            Some((f, last)) if *f == p.symbol.file.as_str() => *last = i,
            _ => runs.push((p.symbol.file.as_str(), i)),
        }
    }
    let mut run_ptr = 0usize;
    let mut since_save = 0usize;
    {
        let emb = st.embedder.lock().map_err(|e| e.to_string())?;
        let Some(embedder) = emb.as_ref() else {
            return Ok(out);
        };
        out.ran = true;
        let mut consecutive_failures = 0usize;
        // `cursor` is the contiguous "no-failure-so-far" position in `points`
        // (advances by `chunk.len()` on each Ok). It gates the per-file
        // checkpoint: a file is done only when its last point index is behind
        // the cursor. On a transient batch Err the cursor FREEZES — the failed
        // chunk's files must not be marked done (resume re-embeds them), and
        // neither must any later file (its points are stored, but marking it
        // done would let resume skip the failed chunk's files ahead of it).
        // NaN-skips are `Ok`, so they advance the cursor (a NaN snippet is
        // permanently skipped, not retried). `out.embedded`/`out.skipped` are
        // cumulative totals for completion/progress; `cursor` is for checkpoint
        // ordering only.
        let mut cursor: usize = 0;
        let mut cursor_frozen = false;
        for chunk in points.chunks(EMBED_BATCH_SIZE) {
            if st.build_cancel.load(Ordering::Relaxed) {
                break;
            }
            match indexer::store::embed_and_store(chunk, embedder.as_ref(), shard) {
                Ok(outcome) => {
                    out.embedded = out.embedded.saturating_add(outcome.stored);
                    out.skipped = out.skipped.saturating_add(outcome.nan_skipped);
                    consecutive_failures = 0;
                    if !cursor_frozen {
                        cursor += chunk.len();
                    }
                }
                Err(e) => {
                    tracing::warn!("codegraph: embed batch failed: {}", e);
                    out.batch_errors = out.batch_errors.saturating_add(1);
                    out.first_err.get_or_insert_with(|| e.to_string());
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    cursor_frozen = true;
                    if consecutive_failures >= 2 {
                        tracing::warn!(
                            "codegraph: embed stopping early after {} consecutive batch failures",
                            consecutive_failures
                        );
                        out.stopped_early = true;
                        break;
                    }
                }
            }
            let processed = out.embedded + out.skipped;
            st.build_done.store(processed, Ordering::Relaxed);
            on_status(&format!("建立索引 {}/{}", processed, total));
            // Checkpoint: every file-run fully behind the cursor is done.
            while run_ptr < runs.len() && runs[run_ptr].1 < cursor {
                checkpoint_files.insert(runs[run_ptr].0.to_string());
                run_ptr += 1;
            }
            since_save += 1;
            if since_save >= 8 {
                indexer::save_embed_checkpoint(base, &indexer::EmbedCheckpoint {
                    shard_dir: shard_dir.to_string(),
                    files: checkpoint_files.clone(),
                });
                since_save = 0;
            }
        }
    }
    out.cancelled = st.build_cancel.load(Ordering::Relaxed);
    // Final checkpoint on every exit path.
    indexer::save_embed_checkpoint(base, &indexer::EmbedCheckpoint {
        shard_dir: shard_dir.to_string(),
        files: checkpoint_files,
    });
    Ok(out)
}

/// Flip the on-disk meta to embed-complete and drop the resume checkpoint (the
/// loaders gate on `embed_complete` first, so a completed build never resumes).
/// Re-reads the meta written at Phase 1 — avoids duplicating Meta construction
/// / shard_dir. Shared by the fresh-build and resume completion paths.
pub(crate) fn mark_embed_complete(root: &std::path::Path, shard_dir: &str) {
    let base = indexer::index_dir(root);
    if let Some(mut meta) = Meta::load(&base.join("meta.json")) {
        // Guard against flipping the wrong shard's flag: if the on-disk meta's
        // shard_dir no longer matches the shard we just embedded (it was
        // rewritten by another build in the meantime), do NOT touch it —
        // flipping would mark a different (possibly vector-less) shard
        // complete and let the loaders serve a broken index. Leave the resume
        // checkpoint in place so the next launch re-evaluates.
        if meta.shard_dir != shard_dir {
            tracing::warn!(
                "codegraph: mark_embed_complete: meta shard_dir {:?} != embedded {:?}, not flipping",
                meta.shard_dir,
                shard_dir
            );
            return;
        }
        meta.embed_complete = true;
        if let Err(e) = meta.save(&base.join("meta.json")) {
            tracing::warn!("codegraph: meta.json embed-complete flip failed: {}", e);
        }
    }
    indexer::clear_embed_checkpoint(&base);
}

/// Coarse health label for the frontend, derived from the build outcome.
/// `structure_only` — no embedder, semantic layer unavailable.
/// `complete` — embed ran to completion with no skips/failures.
/// `degraded` — completed but some symbols were NaN-skipped (semantic layer
///              usable but missing a handful of symbols).
/// `incomplete` — embed didn't finish (cancelled / transient failures / stopped
///                early); resume or rebuild needed.
pub(crate) fn build_health(can_embed: bool, completed: bool, skipped: usize, failed: usize) -> &'static str {
    if !can_embed {
        "structure_only"
    } else if !completed {
        "incomplete"
    } else if skipped > 0 || failed > 0 {
        "degraded"
    } else {
        "complete"
    }
}

/// Reindex a set of files against the live index (per-file write lock so goto
/// can interleave; stops on cancel / index closed / embed no longer ready).
/// Returns (rescanned, errors). Shared by the incremental build and the resume
/// path's changed-file refresh.
pub(crate) fn reindex_files(
    st: &std::sync::Arc<CodeGraphState>,
    root: &std::path::Path,
    files: &[std::path::PathBuf],
    model_name: &str,
    dim: usize,
) -> Result<(usize, usize), String> {
    let mut rescanned = 0usize;
    let mut errors = 0usize;
    for abs in files {
        if st.build_cancel.load(Ordering::Relaxed) {
            break;
        }
        let mut guard = st.inner.write().map_err(|e| e.to_string())?;
        let pi = match guard.as_mut() {
            Some(pi) => pi,
            None => break, // index closed mid-rescan
        };
        if !pi.embed_ready.load(Ordering::Relaxed) {
            break;
        }
        let emb = st.embedder.lock().map_err(|e| e.to_string())?;
        let embedder_ref: Option<&dyn Embedder> = emb.as_ref().map(|b| b.as_ref());
        let shard = pi.shard.clone();
        match indexer::reindex_one(
            root,
            abs,
            &mut pi.symbols,
            &mut pi.edges,
            &shard,
            embedder_ref,
            model_name,
            dim,
            &st.parser_manager,
        ) {
            Ok(_) => rescanned += 1,
            Err(e) => {
                tracing::warn!("codegraph: reindex failed {}: {}", abs.display(), e);
                errors += 1;
            }
        }
    }
    Ok((rescanned, errors))
}

#[cfg(test)]
mod tests {
    use super::run_embed_loop;
    use crate::codegraph::edges::EdgeTable;
    use crate::codegraph::guard;
    use crate::codegraph::incremental::try_incremental_build;
    use crate::codegraph::indexer;
    use crate::codegraph::shard::CodeShard;
    use crate::codegraph::state::{CodeGraphState, ProjectIndex};
    use crate::codegraph::symbols::SymbolTable;
    use crate::codegraph::types::{Confidence, IndexedPoint, SymbolDef, SymbolKind};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::SystemTime;

    /// 4 维假 embedder：批次原样返回零向量，不依赖 ONNX/HTTP。
    struct FakeEmb;
    impl crate::codegraph::embed::Embedder for FakeEmb {
        fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
            Ok(texts.iter().map(|_| vec![0.0f32; 4]).collect())
        }
        fn dim(&self) -> usize { 4 }
        fn model_name(&self) -> &str { "fake" }
    }

    fn mk_point(file: &str, name: &str, line: usize) -> IndexedPoint {
        IndexedPoint {
            symbol: SymbolDef {
                name: name.into(),
                kind: SymbolKind::Function,
                file: file.into(),
                line,
                column: 1,
                parent: None,
                end_line: 0,
            },
            source: Confidence::Structure,
            code_snippet: format!("function {}() {{}}", name),
        }
    }

    fn state_with_fake_embedder() -> CodeGraphState {
        let st = CodeGraphState::new();
        *st.embedder.lock().unwrap() = Some(Box::new(FakeEmb));
        st
    }

    /// Embed 循环跑完后，断点必须覆盖所有文件——这是「中断后续跑只补剩余
    /// 文件」机制的数据源。断点绑定 shard_dir（不匹配时 load 拒绝）。
    #[test]
    fn run_embed_loop_checkpoints_all_completed_files() {
        let base = std::env::temp_dir().join(format!("cg_loop_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let shard = CodeShard::create(&base.join("qdrant-x"), 4).unwrap();
        // 3 points / 2 files：a.ts 两个符号、b.ts 一个。
        let points = vec![
            mk_point("a.ts", "f1", 1),
            mk_point("a.ts", "f2", 2),
            mk_point("b.ts", "g1", 1),
        ];
        let st = state_with_fake_embedder();
        let out = run_embed_loop(
            &st, &base, "qdrant-x", &shard, &points,
            std::collections::HashSet::new(), &|_| {},
        ).unwrap();
        assert!(out.ran && !out.cancelled && !out.stopped_early);
        assert_eq!(out.embedded, 3);
        let cp = indexer::load_embed_checkpoint(&base, "qdrant-x").expect("checkpoint must be saved");
        assert!(cp.files.contains("a.ts"), "a.ts must be checkpointed");
        assert!(cp.files.contains("b.ts"), "b.ts must be checkpointed");
        assert_eq!(st.build_done.load(Ordering::Relaxed), 3, "progress must reach total");
        drop(shard);
        std::fs::remove_dir_all(&base).ok();
    }

    /// 取消（首批前就置 flag）→ 零进度，但断点文件仍落盘（空集）——续跑路径
    /// 据此从头 embed，且不误判任何文件为已完成。
    #[test]
    fn run_embed_loop_cancelled_before_first_batch_saves_empty_checkpoint() {
        let base = std::env::temp_dir().join(format!("cg_loop_cancel_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let shard = CodeShard::create(&base.join("qdrant-y"), 4).unwrap();
        let points = vec![mk_point("a.ts", "f1", 1)];
        let st = state_with_fake_embedder();
        st.build_cancel.store(true, Ordering::Relaxed);
        let out = run_embed_loop(
            &st, &base, "qdrant-y", &shard, &points,
            std::collections::HashSet::new(), &|_| {},
        ).unwrap();
        assert!(out.cancelled, "pre-set cancel flag must stop the loop");
        assert_eq!(out.embedded, 0, "no point embedded after cancel");
        let cp = indexer::load_embed_checkpoint(&base, "qdrant-y").expect("checkpoint must exist");
        assert!(cp.files.is_empty(), "cancelled run must not mark files done");
        drop(shard);
        std::fs::remove_dir_all(&base).ok();
    }

    /// Incremental path: a project with an existing on-disk index, one file
    /// changed → `try_incremental_build` reindexes only that file (not a full
    /// rebuild). Verifies it returns `Some(incremental=true, rescanned=1)`.
    #[test]
    fn try_incremental_build_reindexes_only_changed_files() {
        let dir = std::env::temp_dir().join(format!("cg_incr_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 5 files so 1 change = 20% (within the incremental threshold).
        std::fs::write(dir.join("a.ts"), "class A { save() {} }").unwrap();
        std::fs::write(dir.join("b.ts"), "class B { save() {} }").unwrap();
        std::fs::write(dir.join("c.ts"), "class C { save() {} }").unwrap();
        std::fs::write(dir.join("d.ts"), "class D { save() {} }").unwrap();
        std::fs::write(dir.join("e.ts"), "class E { save() {} }").unwrap();
        let pm = crate::codegraph::parser::ParserManager::new();
        // Build an on-disk structure index. Drop the shard so its dir is
        // released before we re-load it.
        {
            let (_t, _edges, shard, points, _s) =
                crate::codegraph::indexer::build_structure_index(&dir, &pm, 4, "test-model", None, None)
                    .unwrap();
            // Embed the points so the shard has vectors — `load_compatible_index`
            // now sanity-checks point_count against meta.symbol_count and rejects
            // a vector-less "complete" shard as broken.
            for chunk in points.chunks(crate::codegraph::EMBED_BATCH_SIZE) {
                let _ = crate::codegraph::indexer::store::embed_and_store(chunk, &FakeEmb, &shard);
            }
            drop(shard);
        }
        // `build_structure_index` writes `embed_complete: false` (Phase 1 only).
        // Simulate Phase 2 embed completion so `load_compatible_index` will
        // reuse the shard — mirroring production, where the build flips this to
        // true only after the embed loop finishes.
        {
            let base = crate::codegraph::indexer::index_dir(&dir);
            let mut m = crate::codegraph::meta::Meta::load(&base.join("meta.json")).unwrap();
            m.embed_complete = true;
            m.save(&base.join("meta.json")).unwrap();
        }
        // Sleep past the index's second-granularity indexed_at so the post-build
        // mutation is detected (changed_files_since uses `mtime > indexed_at`).
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // Mutate a.ts → only file changed since the build.
        std::fs::write(dir.join("a.ts"), "class A { save() {} load() {} }").unwrap();
        let st = std::sync::Arc::new(CodeGraphState::new());
        let res = try_incremental_build(&st, &dir, "test-model", 4).unwrap();
        assert!(res.is_some(), "incremental must succeed for a small change");
        let json = res.unwrap();
        assert_eq!(json["incremental"], serde_json::Value::Bool(true));
        assert_eq!(
            json["rescanned_files"],
            serde_json::json!(1),
            "only a.ts changed"
        );
        // Drain the swapped-in index so its shard dir is released before cleanup.
        let taken = st.inner.write().unwrap().take();
        guard::drop_catching_panics(taken, "incremental test cleanup");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end regression for the poisoned-lock root cause. This is the
    /// exact build-swap path: the old `ProjectIndex` holds a `CodeShard` whose
    /// directory has been wiped (antivirus / orphan-cleanup race → `os error 3`),
    /// so its `EdgeShard::drop` flush **panics** — the same panic production
    /// logs showed at `qdrant-edge edge/mod.rs:168` from `codegraph_build_index`
    /// and `codegraph_close`.
    ///
    /// The build path swaps in a new index via `guard::swap_returning_old`
    /// (old moved OUTSIDE the lock) + `guard::drop_catching_panics` (panic
    /// caught), so `inner` must NOT poison — the next write succeeds. Before
    /// the fix, the old index was dropped INSIDE the write lock
    /// (`*st.inner.write() = Some(new)`), the flush panic poisoned `inner`, and
    /// every subsequent build returned "poisoned lock: another task failed
    /// inside" until process restart — the persistent "向量索引构建失败".
    #[test]
    fn build_swap_keeps_inner_unpoisoned_when_old_shard_dir_wiped() {
        let dir = std::env::temp_dir().join(format!("cg_e2e_poison_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Old shard with real data so it has segments to flush on drop.
        let old_dir = dir.join("old-shard");
        let old_shard = CodeShard::create(&old_dir, 384).unwrap();
        let pt = IndexedPoint {
            symbol: SymbolDef {
                name: "foo".into(),
                kind: SymbolKind::Function,
                file: "a.ts".into(),
                line: 1,
                column: 1,
                parent: None,
                end_line: 0,
            },
            source: Confidence::Structure,
            code_snippet: "function foo() {}".into(),
        };
        old_shard
            .upsert_with_vectors(&[(pt, vec![0.0f32; 384])])
            .unwrap();
        let old_index = ProjectIndex {
            project_root: dir.clone(),
            symbols: SymbolTable::new(),
            edges: crate::codegraph::edges::EdgeTable::new(),
            shard: Arc::new(old_shard),
            indexed_at: SystemTime::now(),
            embed_ready: Arc::new(AtomicBool::new(true)),
        };
        // Wipe the old shard's dir — its drop will now flush-panic.
        let _ = std::fs::remove_dir_all(&old_dir);

        let st = CodeGraphState::new();
        // The old (doomed) index lives in state before a rebuild swaps it out.
        *st.inner.write().unwrap() = Some(old_index);

        // New shard/index to swap in (build Phase 1).
        let new_dir = dir.join("new-shard");
        let new_shard = CodeShard::create(&new_dir, 384).unwrap();
        let new_index = ProjectIndex {
            project_root: dir.clone(),
            symbols: SymbolTable::new(),
            edges: crate::codegraph::edges::EdgeTable::new(),
            shard: Arc::new(new_shard),
            indexed_at: SystemTime::now(),
            embed_ready: Arc::new(AtomicBool::new(false)),
        };

        // The exact build-swap sequence used by `codegraph_build_index` Phase 1.
        let old = guard::swap_returning_old(&st.inner, new_index);
        guard::drop_catching_panics(old, "old project index (build swap)");

        // The lock must NOT be poisoned: a subsequent write must succeed. This
        // is exactly what failed before the fix — every build after the first
        // drop panic returned "poisoned lock: another task failed inside".
        assert!(
            st.inner.write().is_ok(),
            "inner lock must not be poisoned after the old shard drop panic"
        );

        // Cleanup: drain the new index without poisoning (its dir is intact,
        // but use the same safe path for uniformity).
        let live = st.inner.write().unwrap().take();
        guard::drop_catching_panics(live, "new project index (test cleanup)");
        std::fs::remove_dir_all(&dir).ok();
    }
}