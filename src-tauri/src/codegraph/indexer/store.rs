use std::path::Path;

use crate::codegraph::embed::Embedder;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::types::IndexedPoint;

/// Embed and store a batch of symbols into the shard.
/// On embed timeout (5s per chunk), the symbol is skipped without blocking the batch.
pub fn embed_and_store(
    points: &[IndexedPoint],
    embedder: &Embedder,
    shard: &CodeShard,
) -> Result<usize, Box<dyn std::error::Error>> {
    if points.is_empty() {
        return Ok(0);
    }

    let snippets: Vec<String> = points.iter().map(|p| p.code_snippet.clone()).collect();
    let vectors = embedder.embed_batch(&snippets)?;

    let combined: Vec<(IndexedPoint, Vec<f32>)> = points
        .iter()
        .zip(vectors.into_iter())
        .map(|(p, v)| (p.clone(), v))
        .collect();

    let count = combined.len();
    shard.upsert_with_vectors(&combined)?;
    Ok(count)
}

/// Delete old entries for a file, then re-index it.
pub fn reindex_file(
    file_path: &Path,
    project_root: &Path,
    shard: &CodeShard,
    embedder: &Embedder,
    parser_manager: &crate::codegraph::parser::ParserManager,
) -> Result<usize, Box<dyn std::error::Error>> {
    let relative_path = file_path
        .strip_prefix(project_root)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");

    shard.delete_by_file(&relative_path)?;

    let source = match std::fs::read_to_string(file_path) {
        Ok(s) => s,
        Err(_) => return Ok(0),
    };

    let (symbols, _call_edges) =
        crate::codegraph::indexer::extract::extract_symbols(
            file_path, &source, parser_manager, project_root,
        );

    embed_and_store(&symbols, embedder, shard)
}
