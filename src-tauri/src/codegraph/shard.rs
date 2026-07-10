use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use qdrant_edge::*;
use serde_json::json;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

use crate::codegraph::types::{Confidence, IndexedPoint, SymbolDef};

const VECTOR_NAME: &str = "code-snippet";
const VECTOR_DIM: usize = 384;

pub struct CodeShard {
    inner: EdgeShard,
    dir: PathBuf,
}

impl CodeShard {
    /// Create a fresh shard in `dir`. Fails if `dir` already contains shard data.
    pub fn create(dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        fs_err::create_dir_all(dir)?;
        let config = EdgeConfigBuilder::new()
            .on_disk_payload(true)
            .vector(
                VECTOR_NAME,
                EdgeVectorParamsBuilder::new(VECTOR_DIM, Distance::Cosine)
                    .on_disk(true)
                    .build(),
            )
            .optimizers(EdgeOptimizersConfig {
                deleted_threshold: Some(0.2),
                vacuum_min_vector_number: Some(100),
                default_segment_number: Some(2),
                ..Default::default()
            })
            .wal_options(WalOptions {
                segment_capacity: 4 * 1024 * 1024,
                ..Default::default()
            })
            .build();

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

        Ok(Self {
            inner,
            dir: dir.to_path_buf(),
        })
    }

    /// Open an existing shard from disk.
    pub fn load(dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let config = EdgeConfigBuilder::new()
            .on_disk_payload(true)
            .wal_options(WalOptions {
                segment_capacity: 4 * 1024 * 1024,
                ..Default::default()
            })
            .build();
        let inner = EdgeShard::load(dir, Some(config))?;
        Ok(Self {
            inner,
            dir: dir.to_path_buf(),
        })
    }

    /// Bulk-upsert indexed points. Each point gets an auto-incremented numeric ID.
    pub fn upsert_symbols(&self, points: &[IndexedPoint]) -> Result<(), Box<dyn std::error::Error>> {
        let qpoints: Vec<PointStructPersisted> = points
            .iter()
            .map(|p| {
                let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                // We embed empty vectors here — the actual vector is set by the caller
                // after embedding. For structure-layer points with no vector, use zeros.
                let vec = vec![0.0f32; VECTOR_DIM];
                PointStruct::new(
                    id,
                    Vectors::new_named([(VECTOR_NAME, vec)]),
                    json!({
                        "name": p.symbol.name,
                        "kind": format!("{:?}", p.symbol.kind),
                        "file": p.symbol.file,
                        "line": p.symbol.line,
                        "column": p.symbol.column,
                        "parent": p.symbol.parent,
                        "source": match p.source { Confidence::Structure => "structure", Confidence::Semantic => "semantic" },
                        "code_snippet": p.code_snippet,
                    }),
                )
                .into()
            })
            .collect();

        self.inner.update(UpdateOperation::PointOperation(
            PointOperations::UpsertPoints(PointInsertOperations::PointsList(qpoints)),
        ))?;
        Ok(())
    }

    /// Upsert points that already have their vectors computed.
    pub fn upsert_with_vectors(
        &self,
        points: &[(IndexedPoint, Vec<f32>)],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let qpoints: Vec<PointStructPersisted> = points
            .iter()
            .map(|(p, vec)| {
                let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                PointStruct::new(
                    id,
                    Vectors::new_named([(VECTOR_NAME, vec.clone())]),
                    json!({
                        "name": p.symbol.name,
                        "kind": format!("{:?}", p.symbol.kind),
                        "file": p.symbol.file,
                        "line": p.symbol.line,
                        "column": p.symbol.column,
                        "parent": p.symbol.parent,
                        "source": match p.source { Confidence::Structure => "structure", Confidence::Semantic => "semantic" },
                        "code_snippet": p.code_snippet,
                    }),
                )
                .into()
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
                let payload = &r.payload;
                QueryResult {
                    symbol: SymbolDef {
                        name: payload["name"].as_str().unwrap_or("").to_string(),
                        kind: parse_kind(payload["kind"].as_str().unwrap_or("Variable")),
                        file: payload["file"].as_str().unwrap_or("").to_string(),
                        line: payload["line"].as_u64().unwrap_or(0) as usize,
                        column: payload["column"].as_u64().unwrap_or(0) as usize,
                        parent: payload["parent"].as_str().map(|s| s.to_string()),
                    },
                    confidence: match payload["source"].as_str() {
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
