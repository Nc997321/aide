pub mod indexer;
pub mod types;
pub mod shard;
pub mod embed;
pub mod parser;
pub mod query;
pub mod symbols;
pub mod meta;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

use crate::codegraph::embed::Embedder;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;

/// Snapshot of a fully-built project index, swapped atomically into state.
pub struct ProjectIndex {
    pub project_root: PathBuf,
    pub symbols: SymbolTable,
    pub shard: Arc<CodeShard>,
    pub indexed_at: SystemTime,
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
}

impl CodeGraphState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(None),
            embedder: Mutex::new(None),
            parser_manager: parser::ParserManager::new(),
        }
    }
}

/// Tauri command: build (or load) the full index for a project.
///
/// Heavy IO/CPU (walk + parse + ONNX embed + disk write) runs in
/// `spawn_blocking` off the Tauri main thread. Load-or-build: reuse a fresh
/// on-disk index when available, else full-rebuild and persist.
#[tauri::command]
pub async fn codegraph_build_index(
    project_root: String,
    state: tauri::State<'_, std::sync::Arc<CodeGraphState>>,
) -> Result<serde_json::Value, String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);

        // Fast path: reuse fresh on-disk index.
        if let Some((table, shard)) = indexer::load_project_index(&root, &st.parser_manager) {
            let n = table.len();
            *st.inner.write().map_err(|e| e.to_string())? = Some(ProjectIndex {
                project_root: root,
                symbols: table,
                shard,
                indexed_at: SystemTime::now(),
            });
            return Ok(serde_json::json!({ "loaded": true, "total_symbols": n }));
        }

        // Ensure embedder (best-effort; structure layer works without it).
        {
            let mut emb = st.embedder.lock().map_err(|e| e.to_string())?;
            if emb.is_none() {
                match Embedder::new() {
                    Ok(e) => *emb = Some(e),
                    Err(e) => tracing::warn!("codegraph: embedder unavailable: {}", e),
                }
            }
        }

        let (table, shard, stats) = {
            let emb = st.embedder.lock().map_err(|e| e.to_string())?;
            indexer::build_project_index(&root, emb.as_ref(), &st.parser_manager)
                .map_err(|e| format!("Indexing failed: {}", e))?
        };
        let has_emb = st
            .embedder
            .lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        let n = table.len();
        *st.inner.write().map_err(|e| e.to_string())? = Some(ProjectIndex {
            project_root: root,
            symbols: table,
            shard,
            indexed_at: SystemTime::now(),
        });

        Ok(serde_json::json!({
            "loaded": false,
            "scanned_files": stats.scanned_files,
            "files_with_symbols": stats.files_with_symbols,
            "total_symbols": n,
            "has_embeddings": has_emb,
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
        let (structure, shard_arc) = {
            let guard = st.inner.read().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                None => return Ok(vec![]),
                Some(pi) => (
                    query::structure::structure_lookup(&word, &pi.symbols, line),
                    pi.shard.clone(),
                ),
            }
        };
        if !structure.is_empty() {
            return Ok(structure);
        }
        // 2. semantic — lock embedder, embed word, search shard (read lock already dropped).
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