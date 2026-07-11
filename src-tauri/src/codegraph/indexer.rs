pub mod extract;
pub mod store;
pub mod walk;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::codegraph::embed::Embedder;
use crate::codegraph::meta::{now_epoch, Meta, META_VERSION};
use crate::codegraph::parser::ParserManager;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::IndexedPoint;

use extract::extract_symbols;
use store::embed_and_store;

const MODEL_NAME: &str = "all-MiniLM-L6-v2";

fn index_dir(project_root: &Path) -> PathBuf {
    project_root.join(".aide").join("index")
}

/// Full index build: walk project, parse all files, embed, store.
/// Returns total symbol count and elapsed milliseconds.
pub fn index_all(
    project_root: &Path,
    shard: &CodeShard,
    embedder: Option<&Embedder>,
    parser_manager: &ParserManager,
) -> Result<(usize, usize, usize, u64), Box<dyn std::error::Error>> { // (scanned, with_symbols, embedded, elapsed_ms)
    let start = Instant::now();
    let extensions = parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = extensions.iter().map(|s| *s).collect();
    let files = walk::walk_source_files(project_root, &ext_refs);

    let mut total_symbols = 0usize;
    let mut total_files = 0usize;
    let mut parsed_files = 0usize;

    for file_path in &files {
        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(e) => { tracing::warn!("codegraph: read failed {}: {}", file_path.display(), e); continue; }
        };
        let (symbols, _call_edges) =
            extract_symbols(file_path, &source, parser_manager, project_root);
        parsed_files += 1;
        if symbols.is_empty() {
            continue;
        }
        total_files += 1;
        if let Some(embedder) = embedder {
            match embed_and_store(&symbols, embedder, shard) {
                Ok(count) => total_symbols += count,
                Err(e) => {
                    tracing::warn!("codegraph: embed failed for {}: {}", file_path.display(), e);
                }
            }
        }
    }

    let elapsed = start.elapsed().as_millis() as u64;
    tracing::info!(
        "codegraph: scanned {} files, {} with symbols, {} embedded ({:.1}s){}",
        parsed_files,
        total_files,
        total_symbols,
        elapsed as f64 / 1000.0,
        if embedder.is_some() { String::new() } else { " [no embedding model]".into() }
    );
    Ok((parsed_files, total_files, total_symbols, elapsed))
}

/// Incremental index update for a single file.
pub fn index_file(
    file_path: &Path,
    project_root: &Path,
    shard: &CodeShard,
    embedder: Option<&Embedder>,
    parser_manager: &ParserManager,
) -> Result<usize, Box<dyn std::error::Error>> {
    if let Some(embedder) = embedder {
        store::reindex_file(file_path, project_root, shard, embedder, parser_manager)
    } else {
        Ok(0)
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct BuildStats {
    pub scanned_files: usize,
    pub files_with_symbols: usize,
    pub total_symbols: usize,
}

/// Parse the whole project into an in-memory SymbolTable + the points that
/// will be embedded into the shard. Pure w.r.t. shard/embedder — testable
/// without ONNX or Qdrant.
pub fn collect_symbols(
    project_root: &Path,
    parser_manager: &ParserManager,
) -> (SymbolTable, Vec<IndexedPoint>, BuildStats) {
    let exts = parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = exts.iter().copied().collect();
    let files = walk::walk_source_files(project_root, &ext_refs);

    let mut table = SymbolTable::new();
    let mut all_points: Vec<IndexedPoint> = Vec::new();
    let mut stats = BuildStats::default();

    for file_path in &files {
        stats.scanned_files += 1;
        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("codegraph: read failed {}: {}", file_path.display(), e);
                continue;
            }
        };
        let (points, _edges) =
            extract_symbols(file_path, &source, parser_manager, project_root);
        if points.is_empty() {
            continue;
        }
        stats.files_with_symbols += 1;
        stats.total_symbols += points.len();
        for p in &points {
            table.insert(p.symbol.clone());
        }
        all_points.extend(points);
    }
    (table, all_points, stats)
}

/// Full rebuild: fresh shard + SymbolTable, persisted to disk. Never holds any
/// lock — caller swaps the returned artifacts into state under a brief write lock.
pub fn build_project_index(
    project_root: &Path,
    embedder: Option<&Embedder>,
    parser_manager: &ParserManager,
) -> Result<(SymbolTable, Arc<CodeShard>, BuildStats), Box<dyn std::error::Error>> {
    let base = index_dir(project_root);
    let qdir = base.join("qdrant");
    if qdir.exists() {
        let _ = std::fs::remove_dir_all(&qdir);
    }
    std::fs::create_dir_all(&base)?;
    let shard = CodeShard::create(&qdir)?;

    let (table, points, stats) = collect_symbols(project_root, parser_manager);

    if let Some(embedder) = embedder {
        // embed & store in file-sized batches to cap peak memory
        for chunk in points.chunks(256) {
            if let Err(e) = embed_and_store(chunk, embedder, &shard) {
                tracing::warn!("codegraph: embed batch failed: {}", e);
            }
        }
    }

    // Persist SymbolTable + meta (same transaction point as shard).
    let _ = table.save_json(&base.join("symbols.json"));
    let _ = Meta {
        version: META_VERSION,
        model_name: MODEL_NAME.to_string(),
        indexed_at: now_epoch(),
        symbol_count: table.len(),
    }
    .save(&base.join("meta.json"));

    Ok((table, Arc::new(shard), stats))
}

/// Fast path: reuse on-disk index if fresh. None → caller must full-rebuild.
pub fn load_project_index(
    project_root: &Path,
    parser_manager: &ParserManager,
) -> Option<(SymbolTable, Arc<CodeShard>)> {
    let base = index_dir(project_root);
    let meta = Meta::load(&base.join("meta.json"))?;
    if meta.model_name != MODEL_NAME {
        return None;
    }
    let exts = parser_manager.supported_extensions();
    if crate::codegraph::meta::is_stale(project_root, meta.indexed_at, &exts) {
        return None;
    }
    let table = SymbolTable::load_json(&base.join("symbols.json"))?;
    let shard = CodeShard::load(&base.join("qdrant")).ok()?;
    Some((table, Arc::new(shard)))
}

/// Incremental: drop a file's symbols/points, re-parse it, update table + shard,
/// then re-persist symbols.json + meta so disk stays in sync with the live table.
/// `abs_file` is absolute; it is stripped against `project_root` for the shard
/// key. A missing file is treated as deletion only (table + shard cleared).
pub fn reindex_one(
    project_root: &Path,
    abs_file: &Path,
    table: &mut SymbolTable,
    shard: &CodeShard,
    embedder: Option<&Embedder>,
    parser_manager: &ParserManager,
) -> Result<(), Box<dyn std::error::Error>> {
    let rel = abs_file
        .strip_prefix(project_root)
        .unwrap_or(abs_file)
        .to_string_lossy()
        .replace('\\', "/");

    // remove stale entries for this file
    table.remove_file(&rel);
    shard.delete_by_file(&rel)?;

    let source = match std::fs::read_to_string(abs_file) {
        Ok(s) => s,
        Err(_) => return Ok(()), // file gone → deletion only
    };
    let (points, _edges) = extract::extract_symbols(abs_file, &source, parser_manager, project_root);
    for p in &points {
        table.insert(p.symbol.clone());
    }
    if let Some(embedder) = embedder {
        for chunk in points.chunks(256) {
            let _ = store::embed_and_store(chunk, embedder, shard);
        }
    }

    // Re-persist symbols.json + meta (keep disk in sync with live table).
    let base = project_root.join(".aide").join("index");
    let _ = table.save_json(&base.join("symbols.json"));
    let _ = crate::codegraph::meta::Meta {
        version: crate::codegraph::meta::META_VERSION,
        model_name: MODEL_NAME.to_string(),
        indexed_at: crate::codegraph::meta::now_epoch(),
        symbol_count: table.len(),
    }
    .save(&base.join("meta.json"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::codegraph::parser::ParserManager;
    use super::collect_symbols;

    #[test]
    fn collect_builds_cross_file_table() {
        let dir = std::env::temp_dir().join(format!("cg_collect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("UserService.java"),
            "class UserService { void save() {} }").unwrap();
        std::fs::write(dir.join("OrderService.java"),
            "class OrderService { void save() {} }").unwrap();

        let pm = ParserManager::new();
        let (table, points, stats) = collect_symbols(&dir, &pm);

        // `save` defined in two files → both reachable
        assert_eq!(table.lookup("save").len(), 2);
        assert!(table.lookup("UserService").len() == 1);
        assert!(stats.files_with_symbols == 2);
        assert!(!points.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
