use crate::codegraph::embed::{embed_one, Embedder};
use crate::codegraph::shard::CodeShard;
use crate::codegraph::types::QueryResult;

/// Vector search via Qdrant Edge.
/// Embeds the query text and returns top-K semantically similar results.
pub fn semantic_search(
    query_text: &str,
    embedder: &dyn Embedder,
    shard: &CodeShard,
    limit: usize,
) -> Result<Vec<QueryResult>, Box<dyn std::error::Error>> {
    let vector = embed_one(embedder, query_text)?;
    shard.search(&vector, limit, None)
}
