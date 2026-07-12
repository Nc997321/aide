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

use crate::codegraph::embed::{Embedder, FastEmbedEmbedder, HttpEmbedder, HttpEmbedderConfig, HttpFormat};
use crate::codegraph::meta::Meta;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;
use crate::commands::settings::CodeGraphEmbedderConfig;

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
/// Returns `Ok(Box<dyn Embedder>)` on success. A fastembed init failure or an
/// invalid http config yields an `Err`; the caller logs and proceeds without an
/// embedder (structure layer still works — semantic search is just unavailable).
fn make_embedder(cfg: &CodeGraphEmbedderConfig) -> Result<Box<dyn Embedder>, String> {
    match cfg.backend.as_str() {
        "http" => {
            if cfg.base_url.trim().is_empty() {
                return Err("http embedder: baseUrl is empty".into());
            }
            if cfg.model.trim().is_empty() {
                return Err("http embedder: model is empty".into());
            }
            let format = match cfg.format.as_str() {
                "openai" => HttpFormat::Openai,
                _ => HttpFormat::Ollama,
            };
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
            // "fastembed" or anything else → default local backend.
            FastEmbedEmbedder::new()
                .map(|e| Box::new(e) as Box<dyn Embedder>)
                .map_err(|e| format!("fastembed init failed: {}", e))
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
/// `http` the model_name is the backend prefix only (`ollama` / `openai`) — the
/// concrete model is in the request body, not the identity — and dim is the
/// configured value (or 0 = auto-probe, in which case the on-disk meta's dim
/// is compared against 0 and never matches a real dim, forcing a rebuild on
/// the first build after switching to auto-probe; subsequent builds match
/// because meta is then stamped with the probed dim).
fn config_embedder_identity(cfg: &CodeGraphEmbedderConfig) -> (String, usize) {
    match cfg.backend.as_str() {
        "http" => {
            let name = match cfg.format.as_str() {
                "openai" => "openai",
                _ => "ollama",
            };
            (name.to_string(), cfg.dim as usize)
        }
        _ => ("fastembed:all-MiniLM-L6-v2".to_string(), 384),
    }
}

/// Read the codegraph embedder config from the app config file. The block lives
/// at `config["settings"]["codegraphEmbedder"]` (a field of `AppSettings`).
/// Returns the default (fastembed) if the file or block is missing — zero-config
/// out of the box. Best-effort: malformed JSON → default, logged, never panics.
fn load_embedder_config() -> CodeGraphEmbedderConfig {
    use crate::commands::settings::load_config;
    let config = load_config();
    let Some(cg) = config
        .get("settings")
        .and_then(|s| s.get("codegraphEmbedder"))
    else {
        return CodeGraphEmbedderConfig::default();
    };
    serde_json::from_value::<CodeGraphEmbedderConfig>(cg.clone()).unwrap_or_else(|e| {
        tracing::warn!("codegraph: invalid embedder config, using default: {}", e);
        CodeGraphEmbedderConfig::default()
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
) -> Result<serde_json::Value, String> {
    let force = force.unwrap_or(false);
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);
        let cfg = load_embedder_config();
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
            if let Some((table, shard)) =
                indexer::load_project_index(&root, &st.parser_manager, &model_name, dim)
            {
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
        }

        st.build_cancel.store(false, Ordering::Relaxed);
        st.build_active.store(true, Ordering::Relaxed);
        let on_status = |s: &str| {
            if let Ok(mut g) = st.build_current.lock() {
                g.clear();
                g.push_str(s);
            }
        };

        // Process-start orphan cleanup: if `inner` is empty (fresh process, no
        // live CodeShard in memory and no in-flight goto Arc clones), it's safe
        // to remove leftover `qdrant-*` dirs from previous builds. We keep the
        // meta-pointed dir as a conservative fallback (if this rebuild fails, the
        // old index remains loadable on next start — though stale, it's not gone).
        // When `inner` is Some (same-process rebuild after a config change), we
        // skip cleanup: the old shard is still live (its Arc is in inner + maybe
        // goto clones), so its dir must not be touched — it'll be cleaned on the
        // next process start.
        let inner_is_none = st.inner.read().map(|g| g.is_none()).unwrap_or(true);
        if inner_is_none {
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
        let (table, shard, points, stats) = indexer::build_structure_index(
            &root,
            &st.parser_manager,
            build_dim,
            &model_name,
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
        let mut batch_errors = 0usize;
        if can_embed {
            let emb = st.embedder.lock().map_err(|e| e.to_string())?;
            if let Some(embedder) = emb.as_ref() {
                for chunk in points.chunks(256) {
                    if st.build_cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Err(e) = indexer::store::embed_and_store(chunk, embedder.as_ref(), &shard) {
                        tracing::warn!("codegraph: embed batch failed: {}", e);
                        batch_errors = batch_errors.saturating_add(1);
                    }
                    embedded = embedded.saturating_add(chunk.len());
                    st.build_done.store(embedded, Ordering::Relaxed);
                    on_status(&format!("嵌入符号 {}/{}", embedded, total));
                }
            }
        }
        let cancelled = st.build_cancel.load(Ordering::Relaxed);
        let completed = !cancelled && can_embed && embedded >= total;
        if completed {
            embed_ready.store(true, Ordering::Relaxed);
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
                embed_status = format!("batch_errors: {} (embedded {}/{})", batch_errors, embedded, total);
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
            &shard,
            embedder_ref,
            &model_name,
            dim,
            &st.parser_manager,
        )
        .map_err(|e| format!("reindex failed: {}", e))
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