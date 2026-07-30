pub mod indexer;
pub mod types;
pub mod shard;
pub mod embed;
pub mod parser;
pub mod query;
pub mod symbols;
pub mod edges;
pub mod meta;
pub mod guard;
pub mod agent;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

use crate::codegraph::edges::EdgeTable;
use crate::codegraph::embed::{Embedder, OrtEmbedder, HttpEmbedder, HttpEmbedderConfig, HttpFormat};
use crate::codegraph::meta::Meta;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;
use crate::commands::settings::RuntimeCodeGraphEmbedderConfig;

/// Prefix prepended to every text sent to the embedder (both document snippets
/// and query text, so they share the embedding space).
///
/// **Why:** Ollama `bge-m3` deterministically emits a NaN vector for certain
/// bare code token sequences (a model numerical-overflow bug — not length, not
/// CRLF, but a specific token pattern), which the server cannot JSON-encode →
/// HTTP 500 "failed to encode response: json: unsupported value: NaN". One such
/// snippet fails its whole batch. A short natural-language prefix consistently
/// avoids the NaN trigger across tested snippets, so batches embed in bulk
/// (fast) instead of bisecting to skip every offender (slow). The bisection
/// fallback in `store::embed_and_store` still handles any residual NaN snippet
/// the prefix doesn't cover.
pub(crate) fn embed_input(raw: &str) -> String {
    format!("code: {}", raw)
}

/// Number of code snippets embedded per ONNX forward pass during a full rebuild
/// (Phase 2) and incremental reindex. Each batch allocates attention-score
/// tensors of `(batch, heads=8, seq≤512, seq≤512)` per transformer layer (6
/// layers for all-MiniLM-L6-v2). The old 256/batch figure (~6GB peak, observed
/// via VMMap as the aide.exe 3-6GB heap balloon during rebuilds) was measured
/// WITH the default CPU arena hoarding per-inference temp tensors. The arena is
/// now DISABLED in `OrtEmbedder::new` (`DisableCpuMemArena` +
/// `cpu_arena_allocator=0` + `with_memory_pattern(false)`), so per-batch temp
/// tensors are malloc/free'd and returned to the OS each batch — the 256/batch
/// peak should now be transient, not a hoarded steady-state. Bumped 32→256 to
/// cut rebuild time (~8x fewer batches; 3739 symbols → ~15 batches vs ~117). If
/// the transient peak proves too high in dev, drop to 128/64.
pub(crate) const EMBED_BATCH_SIZE: usize = 256;

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
    pub edges: EdgeTable,
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
    /// Lazily-initialized embedder, created from the configured backend on the
    /// first build (and re-created when the config's model_name changes). Trait
    /// object so the rest of CodeGraph is backend-agnostic.
    embedder: Mutex<Option<Box<dyn Embedder>>>,
    /// Cache of the configured embedder's `model_name()` + `dim()`, so a config
    /// change (backend/model switch) is detected without re-creating the
    /// embedder just to read its identity. Cleared together with `embedder`
    /// when a new config requires a different backend.
    embedder_model: Mutex<Option<(String, usize)>>,
    parser_manager: parser::ParserManager,
    /// Coarse build progress for the frontend to poll (no app.emit — see memory:
    /// cross-thread emit park主线程). Updated from the build's spawn_blocking
    /// task; read by the synchronous `codegraph_build_progress` command. All
    /// `Relaxed`: these are approximate progress hints, not synchronization.
    build_active: AtomicBool,
    build_done: AtomicUsize,
    build_total: AtomicUsize,
    /// 当前阶段/文件的可读描述（"扫描文件树..." / "解析 src/foo.ts (123/456)"
    /// / "建立索引 1340/2000" / "写盘..."）。低频更新（每文件/每批一次），用
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
            embedder_model: Mutex::new(None),
            parser_manager: parser::ParserManager::new(),
            build_active: AtomicBool::new(false),
            build_done: AtomicUsize::new(0),
            build_total: AtomicUsize::new(0),
            build_current: Mutex::new(String::new()),
            build_cancel: AtomicBool::new(false),
        }
    }
}

/// Build a concrete embedder from a config. Match on `backend`:
/// - `fastembed` → local ONNX (may download a model on first use).
/// - `http` → HTTP embedder (Ollama / OpenAI-compatible), format selects the wire shape.
///
/// Returns `Ok(Box<dyn Embedder>)` on success. A local ONNX (ort) embedder init
/// failure or an invalid http config yields an `Err`; the caller logs and proceeds
/// without an embedder (structure layer still works — semantic search is just unavailable).
fn make_embedder(cfg: &RuntimeCodeGraphEmbedderConfig) -> Result<Box<dyn Embedder>, String> {
    match cfg.backend.as_str() {
        "http" => {
            if cfg.base_url.trim().is_empty() {
                return Err("http embedder: baseUrl is empty".into());
            }
            if cfg.model.trim().is_empty() {
                return Err("http embedder: model is empty".into());
            }
            let format = HttpFormat::from_config(&cfg.format);
            let http_cfg = HttpEmbedderConfig {
                base_url: cfg.base_url.clone(),
                api_key: cfg.api_key.clone(),
                model: cfg.model.clone(),
                format,
                dim: cfg.dim as usize,
            };
            HttpEmbedder::new(http_cfg)
                .map(|e| Box::new(e) as Box<dyn Embedder>)
                .map_err(|e| format!("http embedder init failed: {}", e))
        }
        _ => {
            // "fastembed" backend name or anything else → default local ONNX backend.
            // Uses OrtEmbedder (ort direct, CPU arena + memory pattern DISABLED) to
            // avoid the arena-allocator hoarding that ballooned aide.exe to GBs
            // during index rebuilds. See embed.rs `OrtEmbedder` doc for the root cause.
            OrtEmbedder::new()
                .map(|e| Box::new(e) as Box<dyn Embedder>)
                .map_err(|e| format!("ort embedder init failed: {}", e))
        }
    }
}

/// Compute the identity (`model_name`, `dim`) a configured embedder *would*
/// have, **without** constructing it. Used by the build path to short-circuit
/// the on-disk index reuse check: if the cached embedder identity matches the
/// config, we can reuse `load_project_index`; if not, we drop the cached
/// embedder and rebuild.
///
/// For `fastembed` this is a constant (`fastembed:all-MiniLM-L6-v2`, 384). For
/// `http` the model_name is `<prefix>:<model>` (e.g. `ollama:bge-m3`) — the
/// concrete model is part of the identity so swapping the Ollama/OpenAI model
/// (even to another same-dim model) changes the identity and forces a rebuild,
/// rather than silently reusing a shard built in a different vector space. Dim
/// is the configured value (or 0 = auto-probe, in which case the on-disk meta's
/// dim is compared against 0 and never matches a real dim, forcing a rebuild on
/// the first build after switching to auto-probe; subsequent builds match
/// because meta is then stamped with the probed dim).
///
/// Must agree with `HttpEmbedder::model_name()` — both derive prefix + model
/// via `HttpFormat::prefix()` / `from_config` so they stay in sync.
fn config_embedder_identity(cfg: &RuntimeCodeGraphEmbedderConfig) -> (String, usize) {
    match cfg.backend.as_str() {
        "http" => {
            let name = format!("{}:{}", HttpFormat::from_config(&cfg.format).prefix(), cfg.model);
            (name, cfg.dim as usize)
        }
        _ => ("fastembed:all-MiniLM-L6-v2".to_string(), 384),
    }
}

/// Read the codegraph embedder config from the app config file. The block lives
/// at `config["settings"]["codegraphEmbedder"]` (a field of `AppSettings`).
/// Returns the default (fastembed) if the file or block is missing — zero-config
/// out of the box. Best-effort: malformed JSON → default, logged, never panics.
fn load_embedder_config(service: &crate::settings::SettingsService) -> RuntimeCodeGraphEmbedderConfig {
    crate::commands::settings::resolve_codegraph_embedder(service).unwrap_or_else(|error| {
        tracing::warn!("codegraph: invalid embedder config, using default: {error}");
        RuntimeCodeGraphEmbedderConfig { backend: "fastembed".to_string(), base_url: String::new(), api_key: String::new(), model: "nomic-embed-text".to_string(), format: "ollama".to_string(), dim: 0 }
    })
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
        let root = PathBuf::from(&project_root);
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

        // Fast path: reuse fresh on-disk index whose meta matches this embedder
        // (model_name + dim). A backend/model/dim switch won't match → full rebuild.
        // Skipped when `force` (manual 全量重建).
        if !force {
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
                return Ok(serde_json::json!({ "loaded": true, "total_symbols": n }));
            }
        }
        // Strict reuse failed (stale / no index / model mismatch). Before
        // falling back to a full rebuild, try an INCREMENTAL update: if a
        // compatible old index exists and only a few files changed, reindex just
        // those instead of rebuilding the whole project. Returns Some(result) on
        // a successful incremental, None when a full rebuild is required.
        if let Some(json) = try_incremental_build(&st, &root, &model_name, dim)? {
            return Ok(json);
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

        // Phase 2: embed the collected points into the shard (background fill).
        // Structure layer is already swapped in and serving goto; this only adds
        // the semantic layer. Cancelled by close/project switch via build_cancel.
        let total = points.len();
        st.build_total.store(total, Ordering::Relaxed);
        st.build_done.store(0, Ordering::Relaxed);
        on_status(&format!("建立索引 0/{}", total));
        let mut embedded = 0usize;
        let mut batch_errors = 0usize;
        // First batch error message — surfaced in `embed_status` so the user
        // sees the real cause (e.g. Ollama "model not loaded") instead of a
        // bare `batch_errors: N`.
        let mut first_err: Option<String> = None;
        // Stop early after a run of persistent failures. A server-side fault
        // (Ollama HTTP 500, model unloaded, service down) does not recover by
        // retrying every remaining batch — it just stalls for tens of seconds
        // with no new info. Tolerate a single transient hiccup (1 failure),
        // stop after 2 consecutive.
        let mut consecutive_failures = 0usize;
        let mut stopped_early = false;
        if can_embed {
            let emb = st.embedder.lock().map_err(|e| e.to_string())?;
            if let Some(embedder) = emb.as_ref() {
                for chunk in points.chunks(EMBED_BATCH_SIZE) {
                    if st.build_cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    match indexer::store::embed_and_store(chunk, embedder.as_ref(), &shard) {
                        Ok(_) => {
                            consecutive_failures = 0;
                        }
                        Err(e) => {
                            tracing::warn!("codegraph: embed batch failed: {}", e);
                            batch_errors = batch_errors.saturating_add(1);
                            first_err.get_or_insert_with(|| e.to_string());
                            consecutive_failures = consecutive_failures.saturating_add(1);
                            if consecutive_failures >= 2 {
                                tracing::warn!(
                                    "codegraph: embed stopping early after {} consecutive batch failures",
                                    consecutive_failures
                                );
                                stopped_early = true;
                                break;
                            }
                        }
                    }
                    embedded = embedded.saturating_add(chunk.len());
                    st.build_done.store(embedded, Ordering::Relaxed);
                    on_status(&format!("建立索引 {}/{}", embedded, total));
                }
            }
        }
        let cancelled = st.build_cancel.load(Ordering::Relaxed);
        let completed = !cancelled && can_embed && embedded >= total;
        if completed {
            embed_ready.store(true, Ordering::Relaxed);
            // Mark the on-disk meta as embed-complete. Phase 1 wrote
            // `embed_complete: false`; without flipping it here the shard would
            // be rejected on every reuse (load_project_index /
            // load_compatible_index gate on it), forcing a pointless full
            // rebuild next time. Only the full-rebuild completion path needs
            // this — the fast-path reuse already has embed_complete=true (it
            // wouldn't load otherwise) and incremental reindex sets it inside
            // reindex_one. Re-read the meta we wrote in Phase 1, flip the flag,
            // re-save — avoids duplicating Meta construction / shard_dir here.
            let base = indexer::index_dir(&root);
            if let Some(mut meta) = Meta::load(&base.join("meta.json")) {
                meta.embed_complete = true;
                if let Err(e) = meta.save(&base.join("meta.json")) {
                    tracing::warn!("codegraph: meta.json embed-complete flip failed: {}", e);
                }
            }
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
                embed_status = format!("cancelled at {}/{}", embedded, total);
            } else if batch_errors > 0 {
                let first = first_err
                    .as_ref()
                    .map(|e| format!(" — first: {}", e))
                    .unwrap_or_default();
                let why = if stopped_early {
                    format!(
                        "batch_errors: {} (stopped early, embedded {}/{}){}",
                        batch_errors, embedded, total, first
                    )
                } else {
                    format!("batch_errors: {} (embedded {}/{}){}", batch_errors, embedded, total, first)
                };
                embed_status = why;
            } else if !completed {
                embed_status = format!("incomplete: embedded {}/{}", embedded, total);
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
            match query::semantic::semantic_search(&word, embedder.as_ref(), &shard_arc, 10) {
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

/// Attempt an incremental reindex: if a compatible on-disk index exists and
/// only a small set of files changed since its `indexed_at`, load the old
/// index as a base and reindex just the changed files (fast) instead of
/// rebuilding from scratch. Returns `Some(build-result JSON)` on a successful
/// incremental update, or `None` when a full rebuild is required (no reusable
/// base, model/dim mismatch, or too many files changed). Called by
/// `codegraph_build_index` after the strict reuse path fails.
fn try_incremental_build(
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
        tracing::info!(
            "codegraph: incremental skipped ({} of {} files changed > threshold) → full rebuild",
            changed.len(),
            total
        );
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
    // 5. Reindex each changed file (per-file write lock, same pattern as
    //    `codegraph_rescan`). `reindex_one` re-persists symbols.json + meta.json
    //    (indexed_at=now) on each file, so disk stays in sync with the live table.
    st.build_cancel.store(false, Ordering::Relaxed);
    let mut rescanned = 0usize;
    let mut errors = 0usize;
    for abs in &changed {
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
        let shard2 = pi.shard.clone();
        match indexer::reindex_one(
            root,
            abs,
            &mut pi.symbols,
            &mut pi.edges,
            &shard2,
            embedder_ref,
            model_name,
            dim,
            &st.parser_manager,
        ) {
            Ok(_) => rescanned += 1,
            Err(e) => {
                tracing::warn!("codegraph: incremental reindex failed {}: {}", abs.display(), e);
                errors += 1;
            }
        }
    }
    let cancelled = st.build_cancel.load(Ordering::Relaxed);
    let n = {
        let g = st.inner.read().map_err(|e| e.to_string())?;
        g.as_ref().map(|pi| pi.symbols.len()).unwrap_or(0)
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
    Ok(Some(serde_json::json!({
        "loaded": false,
        "incremental": true,
        "rescanned_files": rescanned,
        "total_symbols": n,
        "has_embeddings": true,
        "embed_status": status,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::types::{Confidence, IndexedPoint, SymbolDef, SymbolKind};

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
            let (_t, _edges, shard, _p, _s) =
                crate::codegraph::indexer::build_structure_index(&dir, &pm, 4, "test-model", None, None)
                    .unwrap();
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