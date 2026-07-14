use crate::codegraph::embed::{embed_one, Embedder};
use crate::codegraph::shard::CodeShard;
use crate::codegraph::types::QueryResult;

/// Vector search via Qdrant Edge.
/// Embeds the query text and returns top-K semantically similar results.
///
/// The query is prefixed with `code: ` (via `embed_input`) to match the prefix
/// applied to document snippets at index time — same prefix on both sides keeps
/// queries and documents in the same embedding space, and avoids the bge-m3 NaN
/// trigger on bare code token sequences.
pub fn semantic_search(
    query_text: &str,
    embedder: &dyn Embedder,
    shard: &CodeShard,
    limit: usize,
) -> Result<Vec<QueryResult>, Box<dyn std::error::Error>> {
    let prefixed = crate::codegraph::embed_input(query_text);
    let vector = embed_one(embedder, &prefixed)?;
    shard.search(&vector, limit, None)
}
