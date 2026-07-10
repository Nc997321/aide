pub mod extract;
pub mod store;
pub mod walk;

use std::path::Path;
use std::time::Instant;

use crate::codegraph::embed::Embedder;
use crate::codegraph::parser::ParserManager;
use crate::codegraph::shard::CodeShard;

use extract::extract_symbols;
use store::embed_and_store;

/// Full index build: walk project, parse all files, embed, store.
/// Returns total symbol count and elapsed milliseconds.
pub fn index_all(
    project_root: &Path,
    shard: &CodeShard,
    embedder: &Embedder,
    parser_manager: &ParserManager,
) -> Result<(usize, u64), Box<dyn std::error::Error>> {
    let start = Instant::now();
    let extensions = parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = extensions.iter().map(|s| *s).collect();
    let files = walk::walk_source_files(project_root, &ext_refs);

    let mut total_symbols = 0usize;

    for file_path in &files {
        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (symbols, _call_edges) =
            extract_symbols(file_path, &source, parser_manager, project_root);
        if symbols.is_empty() {
            continue;
        }
        match embed_and_store(&symbols, embedder, shard) {
            Ok(count) => total_symbols += count,
            Err(e) => {
                tracing::warn!("codegraph: embed failed for {}: {}", file_path.display(), e);
            }
        }
    }

    let elapsed = start.elapsed().as_millis() as u64;
    tracing::info!(
        "codegraph: indexed {} symbols in {} files ({:.1}s)",
        total_symbols,
        files.len(),
        elapsed as f64 / 1000.0
    );
    Ok((total_symbols, elapsed))
}

/// Incremental index update for a single file.
pub fn index_file(
    file_path: &Path,
    project_root: &Path,
    shard: &CodeShard,
    embedder: &Embedder,
    parser_manager: &ParserManager,
) -> Result<usize, Box<dyn std::error::Error>> {
    store::reindex_file(file_path, project_root, shard, embedder, parser_manager)
}
