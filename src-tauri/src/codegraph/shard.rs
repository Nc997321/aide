use std::collections::HashMap;
use std::path::{Path, PathBuf};

use qdrant_edge::*;
use serde_json::{json, Value};

use crate::codegraph::types::{Confidence, IndexedPoint, QueryResult, SymbolDef};

const VECTOR_NAME: &str = "code-snippet";
const VECTOR_DIM: usize = 384;

pub struct CodeShard {
    inner: EdgeShard,
    dir: PathBuf,
}

impl CodeShard {
    /// Create a fresh shard in `dir`. Fails if `dir` already contains shard data.
    pub fn create(dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(dir)?;

        let config = EdgeConfig {
            on_disk_payload: true,
            vectors: HashMap::from([(
                VECTOR_NAME.to_string(),
                EdgeVectorParams {
                    size: VECTOR_DIM,
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

        let inner = EdgeShard::new(dir, config)?;

        // Create a keyword index on file path for per-file deletion
        inner.update(UpdateOperation::FieldIndexOperation(
            FieldIndexOperations::CreateIndex(CreateIndex {
                field_name: "file".try_into().unwrap(),
                field_schema: Some(PayloadFieldSchema::FieldType(PayloadSchemaType::Keyword)),
            }),
        ))?;

        // Create keyword index on source confidence for filtering
        inner.update(UpdateOperation::FieldIndexOperation(
            FieldIndexOperations::CreateIndex(CreateIndex {
                field_name: "source".try_into().unwrap(),
                field_schema: Some(PayloadFieldSchema::FieldType(PayloadSchemaType::Keyword)),
            }),
        ))?;

        // Create keyword index on symbol name for exact cross-file structure lookup
        inner.update(UpdateOperation::FieldIndexOperation(
            FieldIndexOperations::CreateIndex(CreateIndex {
                field_name: "name".try_into().unwrap(),
                field_schema: Some(PayloadFieldSchema::FieldType(PayloadSchemaType::Keyword)),
            }),
        ))?;

        Ok(Self {
            inner,
            dir: dir.to_path_buf(),
        })
    }

    /// Open an existing shard from disk.
    pub fn load(dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let config = EdgeConfig {
            on_disk_payload: true,
            vectors: HashMap::from([(
                VECTOR_NAME.to_string(),
                EdgeVectorParams {
                    size: VECTOR_DIM,
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
        let inner = EdgeShard::load(dir, Some(config))?;
        Ok(Self {
            inner,
            dir: dir.to_path_buf(),
        })
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

        self.inner.update(UpdateOperation::PointOperation(
            PointOperations::UpsertPoints(PointInsertOperations::PointsList(qpoints)),
        ))?;
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
        self.inner.update(UpdateOperation::PointOperation(
            PointOperations::DeletePointsByFilter(filter),
        ))?;
        Ok(())
    }

    /// Vector search with optional payload filter.
    pub fn search(
        &self,
        vector: &[f32],
        limit: usize,
        filter: Option<Filter>,
    ) -> Result<Vec<QueryResult>, Box<dyn std::error::Error>> {
        let results = self.inner.query(QueryRequest {
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
        })?;

        let query_results: Vec<QueryResult> = results
            .iter()
            .map(|r| {
                let name = get_payload_str(&r.payload, "name").unwrap_or_default();
                let kind = get_payload_str(&r.payload, "kind").unwrap_or_else(|| "Variable".to_string());
                let file = get_payload_str(&r.payload, "file").unwrap_or_default();
                let line = get_payload_u64(&r.payload, "line").unwrap_or(0) as usize;
                let column = get_payload_u64(&r.payload, "column").unwrap_or(0) as usize;
                let parent = get_payload_str(&r.payload, "parent");
                let source = get_payload_str(&r.payload, "source");

                QueryResult {
                    symbol: SymbolDef {
                        name,
                        kind: parse_kind(&kind),
                        file,
                        line,
                        column,
                        parent,
                    },
                    confidence: match source.as_deref() {
                        Some("structure") => Confidence::Structure,
                        _ => Confidence::Semantic,
                    },
                    score: Some(r.score),
                }
            })
            .collect();

        Ok(query_results)
    }

    /// Run manual segment merge + index rebuild.
    pub fn optimize(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.inner.optimize()?;
        Ok(())
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
    fn point_id_is_deterministic_and_distinct() {
        let a1 = stable_point_id("a.java", 10, 5, "save");
        let a2 = stable_point_id("a.java", 10, 5, "save");
        let b = stable_point_id("a.java", 11, 5, "save");
        let c = stable_point_id("b.java", 10, 5, "save");
        assert_eq!(a1, a2, "same symbol must hash identically (idempotent upsert)");
        assert_ne!(a1, b, "different line must differ");
        assert_ne!(a1, c, "different file must differ");
    }
}
