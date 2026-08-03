use std::collections::HashMap;
use std::path::Path;

use qdrant_edge::*;
use serde_json::{json, Value};

use crate::codegraph::types::{Confidence, IndexedPoint, QueryResult, SymbolDef};

const VECTOR_NAME: &str = "code-snippet";

/// Qdrant Edge shard wrapper.
///
/// `inner` is an `Option` so the `Drop` impl can `take()` the `EdgeShard` out
/// and drop it under `catch_unwind`: `EdgeShard::drop` flushes on Drop and
/// **panics** on IO error (segment temp files missing — `os error 3`, e.g.
/// after antivirus scan or orphan-dir cleanup). Without this guard, that
/// panic unwinds through whoever drops the `CodeShard` — and when the drop
/// happened while a `CodeGraphState` lock was held (build swap / close), it
/// poisoned the lock, producing the persistent "poisoned lock: another task
/// failed inside" / "向量索引构建失败" failure. This is defense-in-depth: the
/// build/close paths additionally drop the old index OUTSIDE the lock (see
/// `codegraph::guard`), so a drop panic can never reach a held lock either way.
pub struct CodeShard {
    inner: Option<EdgeShard>,
}

impl CodeShard {
    /// Borrow the live EdgeShard. Panics only if used after `Drop` already
    /// took it — which never happens in normal use (a dropped CodeShard is
    /// not called again); this is a logic guard, not a runtime path.
    fn edge(&self) -> &EdgeShard {
        self.inner.as_ref().expect("code shard used after drop")
    }
}

/// Run a Qdrant Edge operation, converting any internal **panic** into an
/// `Err` so it can never unwind past the `CodeShard` API boundary.
///
/// ## Why this exists
/// Qdrant Edge operations panic (rather than return `Err`) in several
/// situations: an inconsistent field index on a shard left by a cancelled
/// build (`value not found in value_to_points` — the user-reported
/// `join error: task N panicked`), or a missing-segment IO fault during
/// `update`/`optimize` (antivirus / orphan-cleanup race). When such a panic
/// unwinds through a caller that holds a `CodeGraphState` lock guard
/// (`inner` write guard in `reindex_one` call sites, or the `embedder`
/// `Mutex` guard in the Phase 2 embed loop), std poisons that lock — and the
/// lock stays poisoned until process restart, surfacing as the persistent
/// "poisoned lock: another task failed inside" / "向量索引构建失败"
/// failure. `catch_unwind` at the call site does NOT prevent this (the guard
/// still drops during unwinding with `thread::panicking()` true), so the only
/// robust place to stop the panic is here — inside the shard layer, before it
/// crosses any lock guard.
///
/// `CodeShard::drop` separately catches drop-time flush panics (see
/// `guard::drop_catching_panics`); this catches the in-flight operation
/// panics. Together they make the entire `CodeShard` API panic-safe: no qdrant
/// panic, drop or operation, ever escapes into a caller.
fn catch_qdrant<T, E>(
    label: &str,
    op: impl FnOnce() -> Result<T, E>,
) -> Result<T, Box<dyn std::error::Error>>
where
    E: Into<Box<dyn std::error::Error>>,
{
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(op)) {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(e.into()),
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("(non-string panic payload)");
            Err(format!("qdrant {} panicked: {}", label, msg).into())
        }
    }
}

impl CodeShard {
    /// Create a fresh shard in `dir`. Fails if `dir` already contains shard data.
    /// `dim` is the embedder's vector dimensionality — a shard built for one dim
    /// cannot serve another, so a backend/model switch (different dim) forces a
    /// full rebuild (the caller wipes `qdrant/` before create).
    pub fn create(dir: &Path, dim: usize) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(dir)?;

        let config = EdgeConfig {
            on_disk_payload: true,
            vectors: HashMap::from([(
                VECTOR_NAME.to_string(),
                EdgeVectorParams {
                    size: dim,
                    distance: Distance::Cosine,
                    on_disk: Some(true),
                    multivector_config: None,
                    datatype: None,
                    quantization_config: None,
                    hnsw_config: None,
                },
            )]),
            sparse_vectors: HashMap::new(),
            hnsw_config: Default::default(),
            quantization_config: None,
            optimizers: EdgeOptimizersConfig {
                deleted_threshold: Some(0.2),
                vacuum_min_vector_number: Some(100),
                default_segment_number: Some(2),
                max_segment_size: None,
                indexing_threshold: None,
                prevent_unoptimized: None,
            },
        };

        let inner = catch_qdrant("create (new)", || EdgeShard::new(dir, config))?;

        // Create a keyword index on file path for per-file deletion
        catch_qdrant("create (file index)", || {
            inner.update(UpdateOperation::FieldIndexOperation(
                FieldIndexOperations::CreateIndex(CreateIndex {
                    field_name: "file".try_into().unwrap(),
                    field_schema: Some(PayloadFieldSchema::FieldType(PayloadSchemaType::Keyword)),
                }),
            ))
        })?;

        // Create keyword index on source confidence for filtering
        catch_qdrant("create (source index)", || {
            inner.update(UpdateOperation::FieldIndexOperation(
                FieldIndexOperations::CreateIndex(CreateIndex {
                    field_name: "source".try_into().unwrap(),
                    field_schema: Some(PayloadFieldSchema::FieldType(PayloadSchemaType::Keyword)),
                }),
            ))
        })?;

        // Create keyword index on symbol name for exact cross-file structure lookup
        catch_qdrant("create (name index)", || {
            inner.update(UpdateOperation::FieldIndexOperation(
                FieldIndexOperations::CreateIndex(CreateIndex {
                    field_name: "name".try_into().unwrap(),
                    field_schema: Some(PayloadFieldSchema::FieldType(PayloadSchemaType::Keyword)),
                }),
            ))
        })?;

        Ok(Self { inner: Some(inner) })
    }

    /// Open an existing shard from disk. `dim` must match the dimension the shard
    /// was created with — callers validate this against `meta.json` before load.
    pub fn load(dir: &Path, dim: usize) -> Result<Self, Box<dyn std::error::Error>> {
        let config = EdgeConfig {
            on_disk_payload: true,
            vectors: HashMap::from([(
                VECTOR_NAME.to_string(),
                EdgeVectorParams {
                    size: dim,
                    distance: Distance::Cosine,
                    on_disk: Some(true),
                    multivector_config: None,
                    datatype: None,
                    quantization_config: None,
                    hnsw_config: None,
                },
            )]),
            sparse_vectors: HashMap::new(),
            hnsw_config: Default::default(),
            quantization_config: None,
            optimizers: EdgeOptimizersConfig::default(),
        };
        let inner = catch_qdrant("load", || EdgeShard::load(dir, Some(config)))?;
        Ok(Self { inner: Some(inner) })
    }

    /// Upsert points that already have their vectors computed.
    pub fn upsert_with_vectors(
        &self,
        points: &[(IndexedPoint, Vec<f32>)],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let qpoints: Vec<PointStructPersisted> = points
            .iter()
            .map(|(p, vec)| {
                let id = stable_point_id(&p.symbol.file, p.symbol.line, p.symbol.column, &p.symbol.name);
                let payload_map = json!({
                    "name": p.symbol.name,
                    "kind": format!("{:?}", p.symbol.kind),
                    "file": p.symbol.file,
                    "line": p.symbol.line,
                    "column": p.symbol.column,
                    "parent": p.symbol.parent,
                    "end_line": p.symbol.end_line,
                    "source": match p.source { Confidence::Structure => "structure", Confidence::Semantic => "semantic" },
                    "code_snippet": p.code_snippet,
                });

                PointStructPersisted {
                    id: id.into(),
                    vector: build_named_vector(VECTOR_NAME, vec.clone()),
                    payload: payload_from_value(payload_map),
                }
            })
            .collect();

        let edge = self.edge();
        catch_qdrant("upsert_with_vectors", || {
            edge.update(UpdateOperation::PointOperation(
                PointOperations::UpsertPoints(PointInsertOperations::PointsList(qpoints)),
            ))
        })?;
        Ok(())
    }

    /// Delete all points matching a file path (used during incremental re-index).
    pub fn delete_by_file(&self, file: &str) -> Result<(), Box<dyn std::error::Error>> {
        let filter = Filter {
            must: Some(vec![Condition::Field(FieldCondition::new_match(
                "file".try_into().unwrap(),
                Match::Value(MatchValue {
                    value: ValueVariants::String(file.to_string()),
                }),
            ))]),
            should: None,
            min_should: None,
            must_not: None,
        };
        let edge = self.edge();
        catch_qdrant("delete_by_file", || {
            edge.update(UpdateOperation::PointOperation(
                PointOperations::DeletePointsByFilter(filter),
            ))
        })?;
        Ok(())
    }

    /// Vector search with optional payload filter.
    pub fn search(
        &self,
        vector: &[f32],
        limit: usize,
        filter: Option<Filter>,
    ) -> Result<Vec<QueryResult>, Box<dyn std::error::Error>> {
        let edge = self.edge();
        let results = catch_qdrant("search", || {
            edge.query(QueryRequest {
                prefetches: vec![],
                query: Some(ScoringQuery::Vector(QueryEnum::Nearest(NamedQuery {
                    query: vector.to_vec().into(),
                    using: Some(VECTOR_NAME.to_string()),
                }))),
                filter,
                score_threshold: None,
                limit,
                offset: 0,
                params: None,
                with_vector: WithVector::Bool(false),
                with_payload: WithPayloadInterface::Bool(true),
            })
        })?;

        let query_results: Vec<QueryResult> = results
            .iter()
            .map(|r| {
                let name = get_payload_str(&r.payload, "name").unwrap_or_default();
                let kind = get_payload_str(&r.payload, "kind").unwrap_or_else(|| "Variable".to_string());
                let file = get_payload_str(&r.payload, "file").unwrap_or_default();
                let line = get_payload_u64(&r.payload, "line").unwrap_or(0) as usize;
                let column = get_payload_u64(&r.payload, "column").unwrap_or(0) as usize;
                let end_line = get_payload_u64(&r.payload, "end_line").unwrap_or(0) as usize;
                let parent = get_payload_str(&r.payload, "parent");
                let source = get_payload_str(&r.payload, "source");

                QueryResult {
                    symbol: SymbolDef {
                        name,
                        kind: parse_kind(&kind),
                        file,
                        line,
                        column,
                        end_line,
                        parent,
                    },
                    confidence: match source.as_deref() {
                        Some("structure") => Confidence::Structure,
                        _ => Confidence::Semantic,
                    },
                    score: Some(r.score),
                    snippet: get_payload_str(&r.payload, "code_snippet"),
                }
            })
            .collect();

        Ok(query_results)
    }

    /// Run manual segment merge + index rebuild.
    pub fn optimize(&self) -> Result<(), Box<dyn std::error::Error>> {
        let edge = self.edge();
        catch_qdrant("optimize", || edge.optimize())?;
        Ok(())
    }
}

impl Drop for CodeShard {
    fn drop(&mut self) {
        // Take the EdgeShard out so its Drop (which flushes and may panic on
        // IO error) runs under catch_unwind — a CodeShard drop can never
        // propagate a panic into the caller. If the panic surfaced while a
        // CodeGraphState lock was held, it poisoned the lock; this guard makes
        // that impossible regardless of where the drop happens.
        // Verified load-bearing: with the catch removed, the test
        // `code_shard_drop_swallows_flush_panic_when_dir_wiped` reproduces the
        // exact production panic (`edge/mod.rs:168` — "Failed to flush
        // id_tracker mapping ... os error 3").
        if let Some(inner) = self.inner.take() {
            crate::codegraph::guard::drop_catching_panics(inner, "code shard (EdgeShard drop)");
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers for converting between serde_json / qdrant payload types
// ---------------------------------------------------------------------------

/// Build a `VectorStructPersisted` with a single named dense vector.
fn build_named_vector(name: &str, vec: Vec<f32>) -> VectorStructPersisted {
    let mut map = HashMap::new();
    map.insert(name.to_string(), VectorPersisted::Dense(vec));
    VectorStructPersisted::Named(map)
}

/// Wrap a `serde_json::Value::Object` into qdrant's `Payload(newtype)`.
fn payload_from_value(value: Value) -> Option<Payload> {
    value.as_object().map(|obj| Payload(obj.clone()))
}

/// Extract a string value from an `Option<Payload>` by key.
fn get_payload_str(payload: &Option<Payload>, key: &str) -> Option<String> {
    payload
        .as_ref()
        .and_then(|p| p.0.get(key))
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// Extract a u64 value from an `Option<Payload>` by key.
fn get_payload_u64(payload: &Option<Payload>, key: &str) -> Option<u64> {
    payload
        .as_ref()
        .and_then(|p| p.0.get(key))
        .and_then(|v| v.as_u64())
}

fn parse_kind(s: &str) -> crate::codegraph::types::SymbolKind {
    use crate::codegraph::types::SymbolKind;
    match s {
        "Function" => SymbolKind::Function,
        "Method" => SymbolKind::Method,
        "Class" => SymbolKind::Class,
        "Field" => SymbolKind::Field,
        "Interface" => SymbolKind::Interface,
        "Enum" => SymbolKind::Enum,
        _ => SymbolKind::Variable,
    }
}

/// Deterministic 64-bit point ID from a symbol's identity. Makes upsert
/// idempotent so incremental re-index and reload never collide.
fn stable_point_id(file: &str, line: usize, column: usize, name: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    file.hash(&mut h);
    line.hash(&mut h);
    column.hash(&mut h);
    name.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::stable_point_id;

    #[test]
    fn catch_qdrant_converts_a_panic_into_err() {
        // A qdrant operation that panics (the `value not found in
        // value_to_points` field-index inconsistency, or an IO fault) must
        // surface as an Err, NOT unwind — otherwise it poisons whatever
        // CodeGraphState lock the caller holds.
        let r: Result<(), Box<dyn std::error::Error>> =
            super::catch_qdrant("delete_by_file", || -> Result<(), Box<dyn std::error::Error>> {
                panic!("value getAutonomyDistinguishResult not found in value_to_points");
            });
        let msg = r.unwrap_err().to_string();
        assert!(
            msg.contains("qdrant delete_by_file panicked"),
            "err must name the op, got: {}",
            msg
        );
        assert!(
            msg.contains("value_to_points"),
            "err must carry the panic message, got: {}",
            msg
        );
    }

    #[test]
    fn catch_qdrant_passes_through_ok_and_plain_err() {
        type R = Result<i32, Box<dyn std::error::Error>>;
        let ok: R = super::catch_qdrant("op", || -> R { Ok(42) });
        assert_eq!(ok.unwrap(), 42, "Ok must pass through unchanged");
        let err: R = super::catch_qdrant("op", || -> R { Err("disk full".into()) });
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("disk full") && !msg.contains("panicked"),
            "a normal Err must pass through as-is (not relabeled a panic), got: {}",
            msg
        );
    }

    #[test]
    fn point_id_is_deterministic_and_distinct() {
        let a1 = stable_point_id("a.java", 10, 5, "save");
        let a2 = stable_point_id("a.java", 10, 5, "save");
        let b = stable_point_id("a.java", 11, 5, "save");
        let c = stable_point_id("b.java", 10, 5, "save");
        assert_eq!(a1, a2, "same symbol must hash identically (idempotent upsert)");
        assert_ne!(a1, b, "different line must differ");
        assert_ne!(a1, c, "different file must differ");
    }

    /// Regression for the poisoned-lock root cause. When a shard's directory is
    /// wiped out from under it (antivirus scan / orphan-cleanup race — the exact
    /// `os error 3: 系统找不到指定的路径` in production logs), Qdrant's
    /// `EdgeShard::drop` flush **panics**. `CodeShard::drop` must catch that
    /// panic so it never propagates into a caller holding a `CodeGraphState`
    /// lock (which poisoned `inner` and caused the persistent
    /// "向量索引构建失败" / "poisoned lock" failure).
    #[test]
    fn code_shard_drop_swallows_flush_panic_when_dir_wiped() {
        use crate::codegraph::types::{Confidence, IndexedPoint, SymbolDef, SymbolKind};
        let dir = std::env::temp_dir().join(format!(
            "cg_drop_panic_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = super::CodeShard::create(&dir, 384).unwrap();
        // Put real data in so the shard has segments to flush on drop (an empty
        // shard may have nothing to flush and might not panic).
        let pt = IndexedPoint {
            symbol: SymbolDef {
                name: "foo".into(),
                kind: SymbolKind::Function,
                file: "a.ts".into(),
                line: 1,
                column: 1,
                parent: None,
                end_line: 0,
            },
            source: Confidence::Structure,
            code_snippet: "function foo() {}".into(),
        };
        shard
            .upsert_with_vectors(&[(pt, vec![0.0f32; 384])])
            .unwrap();
        // Wipe the shard dir — EdgeShard::drop flush now hits missing files.
        let _ = std::fs::remove_dir_all(&dir);
        // Before the fix: this drop propagated the flush panic. Now CodeShard::drop
        // catches it via `guard::drop_catching_panics`. Reaching the assert means
        // no panic propagated.
        drop(shard);
        assert!(true, "reached only if CodeShard::drop suppressed the flush panic");
        std::fs::remove_dir_all(&dir).ok();
    }
}
