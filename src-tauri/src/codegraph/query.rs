pub mod semantic;
pub mod structure;

use std::path::Path;

use crate::codegraph::embed::Embedder;
use crate::codegraph::parser::ParserManager;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::types::QueryResult;

/// Main entry point for goto-definition queries.
/// Tries structure layer first; falls back to semantic search if needed.
pub fn query_goto_definition(
    word: &str,
    file: &str,
    line: usize,
    column: usize,
    project_root: &Path,
    shard: Option<&CodeShard>,
    embedder: Option<&Embedder>,
    parser_manager: &ParserManager,
) -> Result<Vec<QueryResult>, String> {
    // 1. Structure layer — exact match via tree-sitter
    let structure_results = structure::structure_lookup(
        word, file, line, column, project_root, parser_manager,
    );

    if !structure_results.is_empty() {
        return Ok(structure_results);
    }

    // 2. Semantic fallback — vector search
    if let (Some(shard), Some(embedder)) = (shard, embedder) {
        let ctx = format!("{} in file {} at line {}", word, file, line);
        match semantic::semantic_search(&ctx, embedder, shard, 10) {
            Ok(mut semantic_results) => {
                // Sort by score descending (best match first)
                semantic_results.sort_by(|a, b| {
                    b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
                });
                return Ok(semantic_results);
            }
            Err(e) => {
                tracing::warn!("codegraph: semantic search failed: {}", e);
            }
        }
    }

    // 3. Nothing found — empty result set triggers frontend grep fallback
    Ok(vec![])
}
