use crate::codegraph::embed::Embedder;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::types::IndexedPoint;

/// Outcome of embedding+storing one batch: how many points were actually stored
/// vs. how many were permanently skipped as NaN-producing snippets. Transient
/// failures (Ollama down / timeout / connection reset) do NOT appear here — they
/// propagate as `Err` so the caller can stop/resume rather than silently drop
/// the batch (the bug that produced "complete" shards with zero vectors).
#[derive(Default, Debug)]
pub struct EmbedStoreOutcome {
    pub stored: usize,
    pub nan_skipped: usize,
}

/// Embed a batch of symbols and upsert them into the shard.
/// Returns an `EmbedStoreOutcome` (stored + nan_skipped). Caller batches in
/// fixed-size chunks (e.g. 256) to cap peak memory during a full build.
///
/// **Bisection fallback for NaN-producing snippets.** Ollama `bge-m3`
/// deterministically emits a NaN vector for certain code snippets (a model
/// numerical-overflow bug — not length, not CRLF, but a specific token
/// sequence), which the server cannot JSON-encode → HTTP 500
/// "failed to encode response: json: unsupported value: NaN". One such snippet
/// fails the *whole* batch. Rather than lose the batch (disabling semantic
/// search for the whole project) or fall back to per-point embedding (256
/// requests/batch — slow, and the request flood knocks Ollama over with
/// `os error 10054`, stalling the build until a `close` cancels it), we
/// **bisect**: on a batch embed error, split in half and retry each half; the
/// half that succeeds is upserted as a batch (fast), the half that fails is
/// recursed until the single offending snippet is isolated and skipped. With
/// sparse NaN snippets this is O(log n) extra requests per bad batch instead
/// of n, so Ollama isn't flooded and the build completes with `embed_ready`
/// minus a handful of symbols.
pub fn embed_and_store(
    points: &[IndexedPoint],
    embedder: &dyn Embedder,
    shard: &CodeShard,
) -> Result<EmbedStoreOutcome, Box<dyn std::error::Error>> {
    if points.is_empty() {
        return Ok(EmbedStoreOutcome::default());
    }
    // Sanitize each snippet with the CodeGraph embed prefix — this avoids the
    // bge-m3 NaN trigger for the vast majority of snippets, so batches embed in
    // bulk (fast path). The bisection fallback below handles any residual NaN
    // snippet the prefix doesn't cover.
    let snippets: Vec<String> = points
        .iter()
        .map(|p| crate::codegraph::embed_input(&p.code_snippet))
        .collect();
    embed_bisect(points, &snippets, embedder, shard)
}

/// Embed `points` and upsert, bisecting on a **NaN** batch embed failure to
/// isolate and skip the offending snippet(s) while upserting the rest as
/// batches. **Transient** failures (Ollama down / timeout / connection reset —
/// any error whose message does NOT contain `NaN`) are propagated as `Err`
/// instead of being bisected/skipped: bisecting a transient fault would silently
/// drop the whole batch (every recursive half errors the same way), producing
/// a "complete" shard with zero vectors — the bug this rewrite fixes.
fn embed_bisect(
    points: &[IndexedPoint],
    snippets: &[String],
    embedder: &dyn Embedder,
    shard: &CodeShard,
) -> Result<EmbedStoreOutcome, Box<dyn std::error::Error>> {
    if points.is_empty() {
        return Ok(EmbedStoreOutcome::default());
    }
    match embedder.embed_batch(snippets) {
        Ok(vectors) => {
            let combined: Vec<(IndexedPoint, Vec<f32>)> = points
                .iter()
                .zip(vectors.into_iter())
                .map(|(p, v)| (p.clone(), v))
                .collect();
            let n = combined.len();
            if let Err(e) = shard.upsert_with_vectors(&combined) {
                tracing::warn!("codegraph: upsert failed ({} points): {}", n, e);
                return Ok(EmbedStoreOutcome::default());
            }
            Ok(EmbedStoreOutcome {
                stored: n,
                nan_skipped: 0,
            })
        }
        Err(err) => {
            // Transient (non-NaN) failure: do NOT bisect — every half would fail
            // the same way and we'd silently drop the whole batch. Propagate Err
            // so run_embed_loop records a batch failure and stops early / resumes
            // next launch instead of marking a vector-less shard "complete".
            if !err.to_string().contains("NaN") {
                return Err(err);
            }
            if points.len() == 1 {
                // Isolated the offending snippet — it embeds to NaN even alone.
                // Skip it (structure layer still has the symbol) and log a
                // preview so the model-side NaN trigger can be tracked.
                tracing::warn!(
                    "codegraph: skipped symbol {}:{} — embed failed (NaN-producing snippet): {} | snippet: {:?}",
                    points[0].symbol.file,
                    points[0].symbol.line,
                    err,
                    snippets[0].chars().take(120).collect::<String>()
                );
                return Ok(EmbedStoreOutcome {
                    stored: 0,
                    nan_skipped: 1,
                });
            }
            // Bisect: retry each half. The half that succeeds upserts as a
            // batch; the half that fails recurses to isolate the bad snippet.
            // `?` propagates a transient Err from either half (no point
            // continuing the other half — the whole batch is retried on resume).
            let mid = points.len() / 2;
            let (left_p, right_p) = points.split_at(mid);
            let (left_s, right_s) = snippets.split_at(mid);
            let mut left = embed_bisect(left_p, left_s, embedder, shard)?;
            let right = embed_bisect(right_p, right_s, embedder, shard)?;
            left.stored += right.stored;
            left.nan_skipped += right.nan_skipped;
            Ok(left)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::embed::Embedder;
    use crate::codegraph::types::{Confidence, IndexedPoint, SymbolDef, SymbolKind};

    /// Embedder that fails any batch containing a snippet marked with the
    /// token `NANTRIGGER` (deterministic, like the residual bge-m3 NaN bug the
    /// `code: ` prefix doesn't cover — the snippet fails even alone), and
    /// succeeds for all other inputs. The `contains` check is prefix-agnostic
    /// so it still fires after `embed_input` prepends `code: `.
    struct NaNEmitter {
        dim: usize,
    }
    impl Embedder for NaNEmitter {
        fn embed_batch(
            &self,
            texts: &[String],
        ) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
            if texts.iter().any(|t| t.contains("NANTRIGGER")) {
                return Err(
                    "embedding endpoint returned 500: failed to encode response: json: unsupported value: NaN".into(),
                );
            }
            Ok(texts.iter().map(|_| vec![0.0f32; self.dim]).collect())
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn model_name(&self) -> &str {
            "test"
        }
    }

    /// Embedder that fails every batch with a transient (non-NaN) connection
    /// error — emulates Ollama going down / `os error 10054` mid-build. Must
    /// propagate as `Err` from `embed_and_store`, NOT be bisected/skipped (the
    /// bug: bisecting a transient fault drops the whole batch silently and
    /// later marks a vector-less shard "embed_complete").
    struct TransientEmitter {
        dim: usize,
    }
    impl Embedder for TransientEmitter {
        fn embed_batch(
            &self,
            _texts: &[String],
        ) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
            Err("os error 10054: connection reset by peer".into())
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn model_name(&self) -> &str {
            "transient"
        }
    }

    fn point(name: &str, line: usize, snippet: &str) -> IndexedPoint {
        IndexedPoint {
            symbol: SymbolDef {
                name: name.into(),
                kind: SymbolKind::Function,
                file: "a.ts".into(),
                line,
                column: 1,
                parent: None,
                end_line: 0,
            },
            source: Confidence::Structure,
            code_snippet: snippet.into(),
        }
    }

    #[test]
    fn bisection_skips_nan_snippet_and_stores_the_rest() {
        let dir = std::env::temp_dir().join(format!("cg_bisect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = crate::codegraph::shard::CodeShard::create(&dir, 4).unwrap();
        let emb = NaNEmitter { dim: 4 };
        // 5 points; the middle one carries the NANTRIGGER marker → poisons the
        // whole batch even after the `code: ` prefix. Bisection isolates and
        // skips it, storing the other 4.
        let pts = vec![
            point("good0", 1, "function good0(){}"),
            point("good1", 2, "function good1(){}"),
            point("bad", 3, "NANTRIGGER snippet here"),
            point("good2", 4, "function good2(){}"),
            point("good3", 5, "function good3(){}"),
        ];
        let outcome = embed_and_store(&pts, &emb, &shard).unwrap();
        assert_eq!(
            outcome.stored, 4,
            "only the NaN snippet must be skipped; the other 4 stored"
        );
        assert_eq!(
            outcome.nan_skipped, 1,
            "the single NaN snippet is counted as skipped"
        );
        drop(shard);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bisection_uses_batch_path_when_no_nan() {
        let dir = std::env::temp_dir().join(format!("cg_bisect_ok_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = crate::codegraph::shard::CodeShard::create(&dir, 4).unwrap();
        let emb = NaNEmitter { dim: 4 };
        let pts: Vec<IndexedPoint> = (0..6)
            .map(|i| point(&format!("g{}", i), i + 1, "all good snippets"))
            .collect();
        let outcome = embed_and_store(&pts, &emb, &shard).unwrap();
        assert_eq!(
            outcome.stored, 6,
            "batch path stores all when no NaN snippet"
        );
        assert_eq!(outcome.nan_skipped, 0, "no NaN → nothing skipped");
        drop(shard);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bisection_skips_multiple_nan_snippets() {
        let dir = std::env::temp_dir().join(format!("cg_bisect_multi_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = crate::codegraph::shard::CodeShard::create(&dir, 4).unwrap();
        let emb = NaNEmitter { dim: 4 };
        let pts = vec![
            point("good0", 1, "ok0"),
            point("bad0", 2, "NANTRIGGER here"),
            point("good1", 3, "ok1"),
            point("bad1", 4, "NANTRIGGER again"),
            point("good2", 5, "ok2"),
            point("bad2", 6, "NANTRIGGER third"),
            point("good3", 7, "ok3"),
        ];
        let outcome = embed_and_store(&pts, &emb, &shard).unwrap();
        assert_eq!(
            outcome.stored, 4,
            "3 NaN snippets skipped, 4 good ones stored"
        );
        assert_eq!(
            outcome.nan_skipped, 3,
            "three NaN snippets counted as skipped"
        );
        drop(shard);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The `code: ` prefix is applied to every snippet before embedding.
    /// Verifies the sanitize step runs (so the prefix reaches the embedder).
    #[test]
    fn embed_and_store_prefixes_snippets() {
        struct SniffEmbedder {
            dim: usize,
            seen: std::sync::Mutex<Vec<String>>,
        }
        impl Embedder for SniffEmbedder {
            fn embed_batch(
                &self,
                texts: &[String],
            ) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
                *self.seen.lock().unwrap() = texts.to_vec();
                Ok(texts.iter().map(|_| vec![0.0f32; self.dim]).collect())
            }
            fn dim(&self) -> usize {
                self.dim
            }
            fn model_name(&self) -> &str {
                "sniff"
            }
        }
        let dir = std::env::temp_dir().join(format!("cg_prefix_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = crate::codegraph::shard::CodeShard::create(&dir, 4).unwrap();
        let emb = SniffEmbedder {
            dim: 4,
            seen: std::sync::Mutex::new(vec![]),
        };
        let pts = vec![point("f", 1, "function f(){}")];
        embed_and_store(&pts, &emb, &shard).unwrap();
        let seen = emb.seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec!["code: function f(){}".to_string()],
            "snippet must be prefixed with 'code: '"
        );
        drop(shard);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Regression for the core bug: a transient (non-NaN) embed failure must
    /// propagate as `Err`, NOT be bisected/skipped. Before the fix, every
    /// recursive half errored the same way and `embed_and_store` returned
    /// `Ok(0)` — silently dropping the whole batch, after which `run_embed_loop`
    /// still counted `chunk.len()` toward completion and `mark_embed_complete`
    /// flipped a vector-less shard to "complete". Now the caller sees the Err,
    /// counts a batch failure, stops early / resumes next launch.
    #[test]
    fn transient_error_propagates_as_err_not_bisected() {
        let dir = std::env::temp_dir().join(format!("cg_transient_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = crate::codegraph::shard::CodeShard::create(&dir, 4).unwrap();
        let emb = TransientEmitter { dim: 4 };
        let pts = vec![
            point("a", 1, "function a(){}"),
            point("b", 2, "function b(){}"),
            point("c", 3, "function c(){}"),
        ];
        let r = embed_and_store(&pts, &emb, &shard);
        let msg = r
            .expect_err("transient (non-NaN) error must propagate as Err, not be bisected/skipped")
            .to_string();
        assert!(
            msg.contains("10054"),
            "err must carry the transient cause through, got: {}",
            msg
        );
        drop(shard);
        std::fs::remove_dir_all(&dir).ok();
    }
}
