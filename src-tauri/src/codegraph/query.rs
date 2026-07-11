pub mod semantic;
pub mod structure;

use crate::codegraph::embed::Embedder;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::QueryResult;

/// Structure layer first (exact, cross-file), semantic vector fallback second.
pub fn query_goto_definition(
    word: &str,
    cursor_line: usize,
    table: &SymbolTable,
    shard: Option<&CodeShard>,
    embedder: Option<&Embedder>,
) -> Vec<QueryResult> {
    let structure_results = structure::structure_lookup(word, table, cursor_line);
    if !structure_results.is_empty() {
        return structure_results;
    }

    if let (Some(shard), Some(embedder)) = (shard, embedder) {
        match semantic::semantic_search(word, embedder, shard, 10) {
            Ok(mut r) => {
                r.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                return r;
            }
            Err(e) => tracing::warn!("codegraph: semantic search failed: {}", e),
        }
    }
    vec![]
}
