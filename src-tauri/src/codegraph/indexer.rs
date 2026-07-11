pub mod extract;
pub mod store;
pub mod walk;

use std::path::Path;
use std::time::Instant;

use crate::codegraph::embed::Embedder;
use crate::codegraph::parser::ParserManager;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::IndexedPoint;

use extract::extract_symbols;
use store::embed_and_store;

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
