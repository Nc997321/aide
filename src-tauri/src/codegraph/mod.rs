pub mod indexer;
pub mod types;
pub mod shard;
pub mod embed;
pub mod parser;
pub mod query;

use std::path::PathBuf;
use std::sync::Mutex;

/// Per-project code graph state. Managed as Arc<Mutex<Option<...>>> in Tauri state.
pub struct CodeGraphState {
    pub project_root: Option<PathBuf>,
    pub shard: Option<shard::CodeShard>,
    pub embedder: Option<embed::Embedder>,
    pub parser_manager: parser::ParserManager,
    pub index_ready: bool,
}

impl CodeGraphState {
    pub fn new() -> Self {
        Self {
            project_root: None,
            shard: None,
            embedder: None,
            parser_manager: parser::ParserManager::new(),
            index_ready: false,
        }
    }
}

/// Tauri command: build full index for a project.
#[tauri::command]
pub async fn codegraph_build_index(
    project_root: String,
    state: tauri::State<'_, std::sync::Arc<Mutex<CodeGraphState>>>,
) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&project_root);

    // Initialize embedder on first call — non-fatal: structure layer still works without it
    let mut g = state.lock().map_err(|e| e.to_string())?;
    if g.embedder.is_none() {
        match embed::Embedder::new() {
            Ok(e) => { g.embedder = Some(e); }
            Err(e) => { tracing::warn!("codegraph: embedding model unavailable, semantic search disabled: {}", e); }
        }
    }

    let index_dir = root.join(".aide").join("index").join("qdrant");

    // Always start fresh on full rebuild — avoids stale data from previous builds
    if index_dir.exists() {
        let _ = std::fs::remove_dir_all(&index_dir);
    }
    let shard = shard::CodeShard::create(&index_dir)
        .map_err(|e| format!("Failed to create index: {}", e))?;

    let (scanned, with_symbols, embedded, elapsed) = indexer::index_all(
        &root,
        &shard,
        g.embedder.as_ref(),
        &g.parser_manager,
    )
    .map_err(|e| format!("Indexing failed: {}", e))?;

    g.project_root = Some(root);
    g.shard = Some(shard);
    g.index_ready = true;

    Ok(serde_json::json!({
        "scanned_files": scanned,
        "files_with_symbols": with_symbols,
        "total_symbols": embedded,
        "elapsed_ms": elapsed,
        "has_embeddings": g.embedder.is_some(),
    }))
}

/// Tauri command: goto-definition query.
#[tauri::command]
pub async fn codegraph_goto_definition(
    word: String,
    file: String,
    line: usize,
    column: usize,
    project_root: String,
    state: tauri::State<'_, std::sync::Arc<Mutex<CodeGraphState>>>,
) -> Result<Vec<types::QueryResult>, String> {
    let root = PathBuf::from(&project_root);
    let g = state.lock().map_err(|e| e.to_string())?;

    query::query_goto_definition(
        &word,
        &file,
        line,
        column,
        &root,
        g.shard.as_ref(),
        g.embedder.as_ref(),
        &g.parser_manager,
    )
}

/// Tauri command: close and flush the index for a project.
#[tauri::command]
pub async fn codegraph_close(
    #[allow(unused_variables)] project_root: String,
    state: tauri::State<'_, std::sync::Arc<Mutex<CodeGraphState>>>,
) -> Result<(), String> {
    let mut g = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref shard) = g.shard {
        shard.optimize().map_err(|e| format!("Optimize failed: {}", e))?;
    }
    // Drop shard (close/flush) — happens when Option is set to None
    g.shard = None;
    g.index_ready = false;
    g.project_root = None;
    Ok(())
}
