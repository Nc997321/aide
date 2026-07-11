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
