# CodeGraph — 增强代码跳转 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 CodeGraph 基础设施——用 tree-sitter（结构层）+ Qdrant Edge + fastembed-rs（语义层）取代现有 grep 级别的 `useGotoDefinition`，实现精确代码跳转。

**Architecture:** 新增独立 Rust 模块 `src-tauri/src/codegraph/`，与现有 `commands/` 平级，纯 Rust 自包含。前端 `useGotoDefinition` 从调 `grepSymbol` 升级为调 `codegraph_goto_definition`，索引未就绪时 fallback 到原 grep。三阶段：底层能力（shard/embed/parser）→ 索引/查询编排 → 前端集成。

**Tech Stack:** qdrant-edge (Rust crate, 嵌入式向量 DB), fastembed-rs (ONNX 推理, 384 维), tree-sitter + 5 语言语法 (Java/TS-JS/Python/Rust/Vue)

## Global Constraints

- 全本地零安装：不依赖 Docker/Ollama/SCIP/JDK/任何外部服务
- 错误不扩散：索引模块任何失败不影响编辑器/聊天/Git 现有功能
- 资源可控：空闲内存增量 < 50MB
- Tauri commands 全走 `async fn` + `spawn_blocking`（不堵主线程）
- tree-sitter 不支持的语言 → 静默跳过结构层，全走语义层
- 模块组织：独立能力模块单文件在顶层，主控+子实现拆为主控+同名子目录
- 跟随现有 IPC 模式：`invoke_handler` 注册 + `api.ts` 包装 + `types.ts` 镜像类型

---

### Task 1: Add Rust dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Produces: `qdrant-edge`, `fastembed`, `tree-sitter`, `tree-sitter-java`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-rust`, `tree-sitter-vue` crates available

- [ ] **Step 1: Add dependencies to Cargo.toml**

Append to the `[dependencies]` section:

```toml
# CodeGraph: embedded vector DB, ONNX embedding inference, syntax parsing
qdrant-edge = "0.6"
fastembed = "4"
tree-sitter = "0.24"
tree-sitter-java = "0.23"
tree-sitter-typescript = "0.23"
tree-sitter-python = "0.23"
tree-sitter-rust = "0.23"
tree-sitter-vue = "0.1"
```

- [ ] **Step 2: Verify build resolves dependencies**

```bash
cd src-tauri && cargo check 2>&1 | tail -5
```
Expected: Downlods crates, no compilation errors (unused deps warning OK).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(codegraph): add qdrant-edge, fastembed, tree-sitter deps

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Core types

**Files:**
- Create: `src-tauri/src/codegraph/types.rs`

**Interfaces:**
- Produces: `SymbolKind`, `Confidence`, `SymbolDef`, `CallEdge`, `IndexedPoint`, `QueryResult`

- [ ] **Step 1: Create directory and types.rs**

```bash
mkdir -p src-tauri/src/codegraph/indexer src-tauri/src/codegraph/query
```

Write `src-tauri/src/codegraph/types.rs`:

```rust
use serde::{Deserialize, Serialize};

/// What kind of symbol this is. Determines tree-sitter node type mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Field,
    Interface,
    Enum,
    Variable,
}

/// Source confidence tier — structure layer is ground truth, semantic is guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Confidence {
    /// Extracted by tree-sitter AST parsing — high confidence.
    Structure,
    /// Retrieved via vector similarity — lower confidence, should be labelled "to verify".
    Semantic,
}

/// A single symbol definition found in source code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolDef {
    pub name: String,
    pub kind: SymbolKind,
    /// Project-relative path, forward slashes.
    pub file: String,
    /// 1-based line number.
    pub line: usize,
    /// 1-based column (byte offset in line).
    pub column: usize,
    /// Containing class name for methods / fields; None for top-level symbols.
    pub parent: Option<String>,
}

/// A directed call edge between two named symbols.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallEdge {
    pub caller: String,
    pub callee: String,
    pub file: String,
    pub line: usize,
}

/// A point stored in the Qdrant Edge shard — symbol + the text used to embed it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedPoint {
    pub symbol: SymbolDef,
    pub source: Confidence,
    /// The exact text chunk that was embedded (method signature + body start, etc.)
    pub code_snippet: String,
}

/// Result returned to the frontend for a goto-definition query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub symbol: SymbolDef,
    pub confidence: Confidence,
    /// Relevance score (only meaningful for Semantic results; 0.0–1.0 range).
    pub score: Option<f32>,
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd src-tauri && cargo check -p aide 2>&1 | tail -5
```
Expected: Compiles clean (crate not yet referenced — "unused" warning OK).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/codegraph/
git commit -m "feat(codegraph): add core types module

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Qdrant Edge Shard lifecycle

**Files:**
- Create: `src-tauri/src/codegraph/shard.rs`

**Interfaces:**
- Produces: `CodeShard` struct with `create()`, `load()`, `upsert_symbols()`, `delete_by_file()`, `search()`, `optimize()` methods

- [ ] **Step 1: Write shard.rs**

```rust
use std::path::{Path, PathBuf};

use qdrant_edge::*;
use serde_json::json;

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
        let _ = fs_err::create_dir_all(dir);
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
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);

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
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);

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
                    confidence: Confidence::Semantic,
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
```

- [ ] **Step 2: Verify compilation**

```bash
cd src-tauri && cargo check -p aide 2>&1 | tail -10
```
Expected: May have errors about unresolved imports from other codegraph modules (mod.rs not yet created). That's OK — we're building bottom-up.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/codegraph/shard.rs
git commit -m "feat(codegraph): add Qdrant Edge shard lifecycle module

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Embedding model (fastembed-rs)

**Files:**
- Create: `src-tauri/src/codegraph/embed.rs`

**Interfaces:**
- Produces: `Embedder` struct with `new()` (auto-download model), `embed_batch()` (texts → Vec<Vec<f32>>)

- [ ] **Step 1: Write embed.rs**

```rust
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::sync::Mutex;

/// Wraps fastembed-rs TextEmbedding model. The model is loaded once and reused.
/// First construction downloads ~23 MB `all-MiniLM-L6-v2` ONNX model from HuggingFace
/// if not cached locally.
pub struct Embedder {
    model: Mutex<TextEmbedding>,
}

impl Embedder {
    /// Create embedder with default model (all-MiniLM-L6-v2, 384-dim).
    /// Blocks briefly on first call while model loads; subsequent calls are fast.
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let model = TextEmbedding::try_new(
            InitOptions::new(EmbeddingModel::AllMiniLML6V2)
        )?;
        Ok(Self {
            model: Mutex::new(model),
        })
    }

    /// Embed a batch of text chunks into 384-dim vectors.
    /// Returns vectors in the same order as `texts`.
    pub fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, Box<dyn std::error::Error>> {
        let model = self.model.lock().unwrap();
        // fastembed accepts &[&str] or &[String] — pass owned Strings
        let embeddings = model.embed(texts.to_vec(), None)?;
        Ok(embeddings)
    }

    /// Embed a single text chunk.
    pub fn embed_one(&self, text: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let batches = self.embed_batch(&[text.to_string()])?;
        Ok(batches.into_iter().next().unwrap_or_default())
    }

    pub fn dim(&self) -> usize {
        384
    }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd src-tauri && cargo check -p aide 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/codegraph/embed.rs
git commit -m "feat(codegraph): add fastembed-rs embedding module

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Tree-sitter parser manager

**Files:**
- Create: `src-tauri/src/codegraph/parser.rs`

**Interfaces:**
- Produces: `ParserManager` struct with `new()` (loads all 5 language grammars), `get_language(ext)` → `Option<Language>`, `parse_file(path, src)` → `Option<Tree>`, `supported_extensions()` → `&[&str]`

- [ ] **Step 1: Write parser.rs**

```rust
use std::collections::HashMap;
use std::path::Path;
use tree_sitter::{Language, Parser, Tree};

/// Maps file extensions to tree-sitter Language grammars.
pub struct ParserManager {
    languages: HashMap<String, Language>,
    extensions: Vec<(&'static str, &'static str)>, // (ext, lang_name)
}

impl ParserManager {
    pub fn new() -> Self {
        let mut languages: HashMap<String, Language> = HashMap::new();
        let mut extensions: Vec<(&str, &str)> = Vec::new();

        // Java
        languages.insert("java".into(), tree_sitter_java::LANGUAGE.into());
        extensions.push(("java", "java"));

        // TypeScript
        languages.insert("ts".into(), tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into());
        extensions.push(("ts", "typescript"));
        // JavaScript (same grammar, different extension)
        languages.insert("js".into(), tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into());
        extensions.push(("js", "javascript"));
        // TSX
        languages.insert("tsx".into(), tree_sitter_typescript::LANGUAGE_TSX.into());
        extensions.push(("tsx", "tsx"));

        // Python
        languages.insert("py".into(), tree_sitter_python::LANGUAGE.into());
        extensions.push(("py", "python"));

        // Rust
        languages.insert("rs".into(), tree_sitter_rust::LANGUAGE.into());
        extensions.push(("rs", "rust"));

        // Vue (single-file component — tree-sitter-vue handles template/script/style)
        languages.insert("vue".into(), tree_sitter_vue::LANGUAGE.into());
        extensions.push(("vue", "vue"));

        Self { languages, extensions }
    }

    /// Get the Language for a file extension, if supported.
    pub fn get_language(&self, ext: &str) -> Option<&Language> {
        self.languages.get(ext)
    }

    /// Check if this file extension is supported.
    pub fn supports_extension(&self, ext: &str) -> bool {
        self.languages.contains_key(ext)
    }

    /// List all supported extensions.
    pub fn supported_extensions(&self) -> Vec<&str> {
        self.extensions.iter().map(|(ext, _)| *ext).collect()
    }

    /// Parse a file's source code, returning the syntax tree.
    /// Returns None if the language isn't supported or parsing fails.
    pub fn parse_file(
        &self,
        file_path: &Path,
        source: &str,
    ) -> Option<Tree> {
        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let language = self.get_language(ext)?;
        let mut parser = Parser::new();
        parser.set_language(language).ok()?;
        parser.parse(source, None)
    }

    /// Parse with a specific language (used when extension is ambiguous).
    pub fn parse_with_language(
        &self,
        language: &Language,
        source: &str,
    ) -> Option<Tree> {
        let mut parser = Parser::new();
        parser.set_language(language).ok()?;
        parser.parse(source, None)
    }
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd src-tauri && cargo check -p aide 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/codegraph/parser.rs
git commit -m "feat(codegraph): add tree-sitter parser manager (5 languages)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Indexer submodule (walk + extract + store + orchestrator)

**Files:**
- Create: `src-tauri/src/codegraph/indexer/walk.rs`
- Create: `src-tauri/src/codegraph/indexer/extract.rs`
- Create: `src-tauri/src/codegraph/indexer/store.rs`
- Create: `src-tauri/src/codegraph/indexer.rs`

**Interfaces:**
- Consumes: `types.rs`, `shard.rs` (CodeShard), `embed.rs` (Embedder), `parser.rs` (ParserManager)
- Produces: `index_all(project_root, shard, embedder, parser)`, `index_file(file_path, shard, embedder, parser)`

- [ ] **Step 1: Write indexer/walk.rs — file tree traversal**

```rust
use std::path::{Path, PathBuf};
use ignore::WalkBuilder;

/// Walk a project directory, returning source files with supported extensions.
/// Respects .gitignore and other ignore rules via the `ignore` crate.
pub fn walk_source_files(
    project_root: &Path,
    supported_extensions: &[&str],
) -> Vec<PathBuf> {
    let exts: Vec<&str> = supported_extensions.to_vec();
    WalkBuilder::new(project_root)
        .standard_filters(true) // respect .gitignore, .ignore, etc.
        .hidden(false)          // skip hidden files/dirs
        .build()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                return None;
            }
            let path = entry.into_path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if exts.contains(&ext) {
                Some(path)
            } else {
                None
            }
        })
        .collect()
}
```

- [ ] **Step 2: Write indexer/extract.rs — parse AST, extract symbols**

```rust
use std::path::Path;
use tree_sitter::Node;

use crate::codegraph::parser::ParserManager;
use crate::codegraph::types::{CallEdge, Confidence, IndexedPoint, SymbolDef, SymbolKind};

/// Extract symbols and call edges from a single file's AST.
pub fn extract_symbols(
    file_path: &Path,
    source: &str,
    parser_manager: &ParserManager,
    project_root: &Path,
) -> (Vec<IndexedPoint>, Vec<CallEdge>) {
    let tree = match parser_manager.parse_file(file_path, source) {
        Some(t) => t,
        None => return (vec![], vec![]),
    };

    let root_node = tree.root_node();
    let relative_path = file_path
        .strip_prefix(project_root)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");

    let mut symbols: Vec<IndexedPoint> = Vec::new();
    let mut call_edges: Vec<CallEdge> = Vec::new();

    // Walk all named nodes looking for definitions and calls
    extract_from_node(
        &root_node,
        source,
        &relative_path,
        None,
        &mut symbols,
        &mut call_edges,
    );

    (symbols, call_edges)
}

fn extract_from_node(
    node: &Node,
    source: &str,
    file: &str,
    parent_class: Option<&str>,
    symbols: &mut Vec<IndexedPoint>,
    call_edges: &mut Vec<CallEdge>,
) {
    let kind = node.kind();

    match kind {
        // ── Definition nodes ──
        "class_declaration" | "class_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node.utf8_text(source.as_bytes()).unwrap_or("");
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: SymbolKind::Class,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: None,
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
                // Recurse into class body with this class as parent
                let parent = name.to_string();
                for i in 0..node.child_count() {
                    if let Some(child) = node.child(i) {
                        extract_from_node(
                            &child, source, file, Some(&parent),
                            symbols, call_edges,
                        );
                    }
                }
                return; // children already handled
            }
        }

        "interface_declaration" | "interface_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node.utf8_text(source.as_bytes()).unwrap_or("");
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: SymbolKind::Interface,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: None,
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
            }
        }

        "enum_declaration" | "enum_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node.utf8_text(source.as_bytes()).unwrap_or("");
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: SymbolKind::Enum,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: None,
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
            }
        }

        "method_declaration" | "function_declaration"
        | "method_definition" | "function_definition"
        | "function_item" | "constructor_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node.utf8_text(source.as_bytes()).unwrap_or("");
                let start = node.start_position();
                let kind = if parent_class.is_some() || kind.contains("method") {
                    SymbolKind::Method
                } else {
                    SymbolKind::Function
                };
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: parent_class.map(|s| s.to_string()),
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
            }
        }

        "field_declaration" | "variable_declarator"
        | "public_field_definition" | "property_definition" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                let name = name_node.utf8_text(source.as_bytes()).unwrap_or("");
                let start = node.start_position();
                symbols.push(IndexedPoint {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: if parent_class.is_some() { SymbolKind::Field } else { SymbolKind::Variable },
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: parent_class.map(|s| s.to_string()),
                    },
                    source: Confidence::Structure,
                    code_snippet: node_text_snippet(node, source),
                });
            }
        }

        // ── Call nodes ──
        "method_invocation" | "function_call" | "call_expression" => {
            if let Some(name_node) = node.child_by_field_name("name")
                .or_else(|| node.child_by_field_name("function"))
            {
                let callee = name_node.utf8_text(source.as_bytes()).unwrap_or("");
                let start = node.start_position();
                call_edges.push(CallEdge {
                    caller: String::new(), // resolved by context (current function)
                    callee: callee.to_string(),
                    file: file.to_string(),
                    line: start.row + 1,
                });
            }
        }

        _ => {}
    }

    // Recurse into children (unless early-returned for class_declaration)
    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            extract_from_node(&child, source, file, parent_class, symbols, call_edges);
        }
    }
}

/// Get a short text snippet from a node for embedding purposes.
fn node_text_snippet(node: &Node, source: &str) -> String {
    let text = node.utf8_text(source.as_bytes()).unwrap_or("");
    // Take first 512 chars — long enough for embedding, short enough to be cheap
    if text.len() > 512 {
        format!("{}...", &text[..509])
    } else {
        text.to_string()
    }
}
```

- [ ] **Step 3: Write indexer/store.rs — embed + upsert pipeline**

```rust
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
```

- [ ] **Step 4: Write indexer.rs — orchestrator**

```rust
pub mod extract;
pub mod store;
pub mod walk;

use std::path::Path;
use std::time::Instant;

use crate::codegraph::embed::Embedder;
use crate::codegraph::parser::ParserManager;
use crate::codegraph::shard::CodeShard;

use extract::extract_symbols;
use store::embed_and_store;

/// Full index build: walk project, parse all files, embed, store.
/// Returns total symbol count and elapsed milliseconds.
pub fn index_all(
    project_root: &Path,
    shard: &CodeShard,
    embedder: &Embedder,
    parser_manager: &ParserManager,
) -> Result<(usize, u64), Box<dyn std::error::Error>> {
    let start = Instant::now();
    let extensions = parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = extensions.iter().map(|s| *s).collect();
    let files = walk::walk_source_files(project_root, &ext_refs);

    let mut total_symbols = 0usize;

    for file_path in &files {
        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (symbols, _call_edges) =
            extract_symbols(file_path, &source, parser_manager, project_root);
        if symbols.is_empty() {
            continue;
        }
        match embed_and_store(&symbols, embedder, shard) {
            Ok(count) => total_symbols += count,
            Err(e) => {
                tracing::warn!("codegraph: embed failed for {}: {}", file_path.display(), e);
            }
        }
    }

    let elapsed = start.elapsed().as_millis() as u64;
    tracing::info!(
        "codegraph: indexed {} symbols in {} files ({:.1}s)",
        total_symbols,
        files.len(),
        elapsed as f64 / 1000.0
    );
    Ok((total_symbols, elapsed))
}

/// Incremental index update for a single file.
pub fn index_file(
    file_path: &Path,
    project_root: &Path,
    shard: &CodeShard,
    embedder: &Embedder,
    parser_manager: &ParserManager,
) -> Result<usize, Box<dyn std::error::Error>> {
    store::reindex_file(file_path, project_root, shard, embedder, parser_manager)
}
```

- [ ] **Step 5: Verify compilation**

```bash
cd src-tauri && cargo check -p aide 2>&1 | tail -10
```

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/codegraph/indexer/
git commit -m "feat(codegraph): add indexer submodule (walk + extract + store)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Query submodule (structure + semantic + orchestrator)

**Files:**
- Create: `src-tauri/src/codegraph/query/structure.rs`
- Create: `src-tauri/src/codegraph/query/semantic.rs`
- Create: `src-tauri/src/codegraph/query.rs`

**Interfaces:**
- Consumes: `types.rs`, `shard.rs`, `embed.rs`, `parser.rs`
- Produces: `query_goto_definition(word, file, line, project_root, shard, embedder, parser)` → `Vec<QueryResult>`

- [ ] **Step 1: Write query/structure.rs — tree-sitter exact lookup**

```rust
use std::path::Path;

use crate::codegraph::parser::ParserManager;
use crate::codegraph::types::{Confidence, QueryResult, SymbolDef, SymbolKind};

/// Search for a symbol definition/reference within a file using tree-sitter.
/// Returns struct-layer results if the word is found as a named node in the AST.
pub fn structure_lookup(
    word: &str,
    file_path: &str,
    line: usize,
    _column: usize,
    project_root: &Path,
    parser_manager: &ParserManager,
) -> Vec<QueryResult> {
    let full_path = project_root.join(file_path);
    let source = match std::fs::read_to_string(&full_path) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let tree = match parser_manager.parse_file(&full_path, &source) {
        Some(t) => t,
        None => return vec![],
    };

    let root_node = tree.root_node();
    let mut results: Vec<QueryResult> = Vec::new();
    find_definitions_for_word(&root_node, word, file_path, &source, &mut results);

    // Deduplicate by (file, line, name)
    results.sort_by(|a, b| {
        a.symbol.file.cmp(&b.symbol.file)
            .then(a.symbol.line.cmp(&b.symbol.line))
    });
    results.dedup_by(|a, b| {
        a.symbol.file == b.symbol.file
            && a.symbol.line == b.symbol.line
            && a.symbol.name == b.symbol.name
    });

    // Put closest-to-cursor results first
    results.sort_by_key(|r| {
        (r.symbol.line as isize - line as isize).unsigned_abs()
    });

    results
}

fn find_definitions_for_word(
    node: &tree_sitter::Node,
    word: &str,
    file: &str,
    source: &str,
    results: &mut Vec<QueryResult>,
) {
    let kind = node.kind();

    if is_definition_kind(kind) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = name_node.utf8_text(source.as_bytes()).unwrap_or("");
            if name == word {
                let start = node.start_position();
                let mut parent_class: Option<String> = None;
                // Try to find containing class
                let mut cursor = node.walk();
                while cursor.goto_parent() {
                    let p = cursor.node();
                    let pk = p.kind();
                    if pk == "class_declaration" || pk == "class_definition"
                        || pk == "interface_declaration" || pk == "interface_definition"
                    {
                        if let Some(pn) = p.child_by_field_name("name") {
                            parent_class = Some(pn.utf8_text(source.as_bytes()).unwrap_or("").to_string());
                        }
                        break;
                    }
                }

                results.push(QueryResult {
                    symbol: SymbolDef {
                        name: name.to_string(),
                        kind: kind_to_symbol_kind(kind),
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: parent_class,
                    },
                    confidence: Confidence::Structure,
                    score: None,
                });
            }
        }
    }

    // Also search for references in method_invocation nodes
    if kind == "method_invocation" || kind == "call_expression" {
        if let Some(name_node) = node.child_by_field_name("name")
            .or_else(|| node.child_by_field_name("function"))
        {
            let callee = name_node.utf8_text(source.as_bytes()).unwrap_or("");
            if callee == word {
                let start = node.start_position();
                results.push(QueryResult {
                    symbol: SymbolDef {
                        name: callee.to_string(),
                        kind: SymbolKind::Method,
                        file: file.to_string(),
                        line: start.row + 1,
                        column: start.column + 1,
                        parent: None,
                    },
                    confidence: Confidence::Structure,
                    score: None,
                });
            }
        }
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            find_definitions_for_word(&child, word, file, source, results);
        }
    }
}

fn is_definition_kind(kind: &str) -> bool {
    matches!(
        kind,
        "class_declaration" | "class_definition"
        | "method_declaration" | "method_definition"
        | "function_declaration" | "function_definition"
        | "function_item"
        | "interface_declaration" | "interface_definition"
        | "enum_declaration" | "enum_definition"
        | "field_declaration" | "variable_declarator"
        | "public_field_definition" | "property_definition"
        | "constructor_declaration"
    )
}

fn kind_to_symbol_kind(kind: &str) -> SymbolKind {
    match kind {
        "class_declaration" | "class_definition" => SymbolKind::Class,
        "method_declaration" | "method_definition" | "constructor_declaration" => SymbolKind::Method,
        "function_declaration" | "function_definition" | "function_item" => SymbolKind::Function,
        "interface_declaration" | "interface_definition" => SymbolKind::Interface,
        "enum_declaration" | "enum_definition" => SymbolKind::Enum,
        "field_declaration" | "variable_declarator"
        | "public_field_definition" | "property_definition" => SymbolKind::Field,
        _ => SymbolKind::Variable,
    }
}
```

- [ ] **Step 2: Write query/semantic.rs — Qdrant vector search**

```rust
use crate::codegraph::embed::Embedder;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::types::QueryResult;

/// Vector search via Qdrant Edge.
/// Embeds the query text and returns top-K semantically similar results.
pub fn semantic_search(
    query_text: &str,
    embedder: &Embedder,
    shard: &CodeShard,
    limit: usize,
) -> Result<Vec<QueryResult>, Box<dyn std::error::Error>> {
    let vector = embedder.embed_one(query_text)?;
    shard.search(&vector, limit, None)
}
```

- [ ] **Step 3: Write query.rs — orchestrator**

```rust
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
                // Deduplicate: if semantic result matches a known structure symbol,
                // absorb it (don't show duplicate)
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
```

- [ ] **Step 4: Verify compilation**

```bash
cd src-tauri && cargo check -p aide 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codegraph/query/
git commit -m "feat(codegraph): add query submodule (structure + semantic)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Module entry point + Tauri command registration + lib.rs wiring

**Files:**
- Create: `src-tauri/src/codegraph/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: All codegraph submodules
- Produces: `CodeGraphState` (Arc-managed state), three Tauri commands

- [ ] **Step 1: Write mod.rs — module entry + state + commands**

```rust
pub mod embed;
pub mod indexer;
pub mod parser;
pub mod query;
pub mod shard;
pub mod types;

use std::path::PathBuf;
use std::sync::Mutex;

/// Per-project code graph state. Managed as Arc<Mutex<Option<...>>> in Tauri state.
pub struct CodeGraphState {
    pub project_root: Option<PathBuf>,
    pub shard: Option<shard::CodeShard>,
    pub embedder: Option<embed::Embedder>,
    pub parser_manager: parser::ParserManager,
    pub index_ready: bool,
}

impl CodeGraphState {
    pub fn new() -> Self {
        Self {
            project_root: None,
            shard: None,
            embedder: None,
            parser_manager: parser::ParserManager::new(),
            index_ready: false,
        }
    }
}

/// Tauri command: build full index for a project.
#[tauri::command]
pub async fn codegraph_build_index(
    project_root: String,
    state: tauri::State<'_, std::sync::Arc<Mutex<CodeGraphState>>>,
) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&project_root);

    // Initialize embedder on first call
    let mut g = state.lock().map_err(|e| e.to_string())?;
    if g.embedder.is_none() {
        g.embedder = Some(embed::Embedder::new().map_err(|e| format!("Failed to load embedding model: {}", e))?);
    }

    let index_dir = root.join(".aide").join("index").join("qdrant");

    // Create or load shard (with corruption recovery: if load fails, remove + recreate)
    let shard = if index_dir.exists() {
        shard::CodeShard::load(&index_dir).unwrap_or_else(|_| {
            tracing::warn!("codegraph: shard corrupt, rebuilding");
            let _ = std::fs::remove_dir_all(&index_dir);
            shard::CodeShard::create(&index_dir).expect("Failed to create shard after recovery")
        })
    } else {
        shard::CodeShard::create(&index_dir).map_err(|e| format!("Failed to create index: {}", e))?
    };

    let (total, elapsed) = indexer::index_all(
        &root,
        &shard,
        g.embedder.as_ref().unwrap(),
        &g.parser_manager,
    )
    .map_err(|e| format!("Indexing failed: {}", e))?;

    g.project_root = Some(root);
    g.shard = Some(shard);
    g.index_ready = true;

    Ok(serde_json::json!({
        "total_symbols": total,
        "elapsed_ms": elapsed,
    }))
}

/// Tauri command: goto-definition query.
#[tauri::command]
pub async fn codegraph_goto_definition(
    word: String,
    file: String,
    line: usize,
    column: usize,
    project_root: String,
    state: tauri::State<'_, std::sync::Arc<Mutex<CodeGraphState>>>,
) -> Result<Vec<types::QueryResult>, String> {
    let root = PathBuf::from(&project_root);
    let g = state.lock().map_err(|e| e.to_string())?;

    query::query_goto_definition(
        &word,
        &file,
        line,
        column,
        &root,
        g.shard.as_ref(),
        g.embedder.as_ref(),
        &g.parser_manager,
    )
}

/// Tauri command: close and flush the index for a project.
#[tauri::command]
pub async fn codegraph_close(
    #[allow(unused_variables)] project_root: String,
    state: tauri::State<'_, std::sync::Arc<Mutex<CodeGraphState>>>,
) -> Result<(), String> {
    let mut g = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref shard) = g.shard {
        shard.optimize().map_err(|e| format!("Optimize failed: {}", e))?;
    }
    // Drop shard (close/flush) — happens when Option is set to None
    g.shard = None;
    g.index_ready = false;
    g.project_root = None;
    Ok(())
}
```

- [ ] **Step 2: Wire into lib.rs — register module + state + commands**

Edit `src-tauri/src/lib.rs`:

Add module declaration after existing `mod` lines (line 5 area):
```rust
mod codegraph;
```

In the `build()` chain, after `.manage(workspace_state)` (line 90 area), add:
```rust
        .manage(std::sync::Arc::new(std::sync::Mutex::new(
            codegraph::CodeGraphState::new(),
        )))
```

In the `invoke_handler` macro, add three new entries before `]`:
```rust
            codegraph::codegraph_build_index,
            codegraph::codegraph_goto_definition,
            codegraph::codegraph_close,
```

- [ ] **Step 3: Verify compilation**

```bash
cd src-tauri && cargo check -p aide 2>&1 | tail -10
```
Expected: Compiles clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/codegraph/mod.rs src-tauri/src/lib.rs
git commit -m "feat(codegraph): wire module entry, Tauri commands, lib.rs registration

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Frontend types + API wrappers

**Files:**
- Modify: `src/types.ts` — add query result types
- Modify: `src/api.ts` — add invoke wrappers

- [ ] **Step 1: Add frontend types**

In `src/types.ts`, append:
```typescript
// ── CodeGraph types ──

export type SymbolKind =
  | "Function" | "Method" | "Class" | "Field"
  | "Interface" | "Enum" | "Variable";

export type Confidence = "Structure" | "Semantic";

export interface SymbolDef {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  column: number;
  parent: string | null;
}

export interface QueryResult {
  symbol: SymbolDef;
  confidence: Confidence;
  score: number | null;
}

export interface BuildIndexResult {
  total_symbols: number;
  elapsed_ms: number;
}
```

- [ ] **Step 2: Add API wrappers**

In `src/api.ts`, append inside the `api` object:
```typescript
  // CodeGraph — enhanced code navigation
  codegraphBuildIndex(projectRoot: string): Promise<BuildIndexResult> {
    return invoke("codegraph_build_index", { projectRoot });
  },
  codegraphGotoDefinition(
    word: string,
    file: string,
    line: number,
    column: number,
    projectRoot: string,
  ): Promise<QueryResult[]> {
    return invoke("codegraph_goto_definition", { word, file, line, column, projectRoot });
  },
  codegraphClose(projectRoot: string): Promise<void> {
    return invoke("codegraph_close", { projectRoot });
  },
```

- [ ] **Step 3: Verify frontend compiles**

```bash
cd src && npx vue-tsc --noEmit 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/api.ts
git commit -m "feat(codegraph): add frontend types and API wrappers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Upgrade useGotoDefinition

**Files:**
- Modify: `src/composables/useGotoDefinition.ts`

**Interfaces:**
- Consumes: `api.codegraphGotoDefinition`, new `QueryResult` type
- Produces: Same public API (`search`, `searchAllReferences`, `dismiss`, ...), now backed by CodeGraph with grep fallback

- [ ] **Step 1: Rewrite useGotoDefinition.ts**

Replace `src/composables/useGotoDefinition.ts`:

```typescript
import { ref, readonly } from "vue";
import { api } from "../api";
import type { GrepMatch, QueryResult } from "../types";

// Module-level singleton
const visible = ref(false);
const results = ref<QueryResult[]>([]);
const selectedIndex = ref(0);
const searchWord = ref("");
const currentFilePath = ref("");
const targetProjectRoot = ref("");
const isGrepFallback = ref(false);

let lastProjectRoot = "";
let lastSourceExt = "";

export function useGotoDefinition() {
  async function search(
    word: string,
    projectRoot: string,
    source?: { sourceFile: string; sourceLine: number; sourceExt: string },
  ) {
    if (!word || !projectRoot) return;

    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    lastProjectRoot = projectRoot;
    lastSourceExt = source?.sourceExt || "";
    results.value = [];
    selectedIndex.value = 0;
    visible.value = true;
    isGrepFallback.value = false;

    // 1. Try CodeGraph first
    try {
      const cgResults = await api.codegraphGotoDefinition(
        word,
        source?.sourceFile || "",
        source?.sourceLine || 0,
        0, // column not yet from editor
        projectRoot,
      );

      if (cgResults.length > 0) {
        // Filter out self-reference (same file, same line)
        let filtered = cgResults;
        if (source?.sourceFile) {
          filtered = cgResults.filter(
            r => !(r.symbol.file === source.sourceFile && r.symbol.line === source.sourceLine),
          );
        }
        results.value = filtered;
        return;
      }
    } catch {
      // CodeGraph unavailable — fall through to grep
    }

    // 2. Fallback: grep-level search (existing behavior)
    isGrepFallback.value = true;
    try {
      let matches: GrepMatch[] = await api.grepSymbol(word, projectRoot, source?.sourceExt);
      if (source?.sourceFile) {
        matches = matches.filter(
          m => !(m.file === source.sourceFile && m.line === source.sourceLine),
        );
      }
      // Convert GrepMatch[] to QueryResult[] for unified rendering
      results.value = matches.slice(0, 20).map(m => ({
        symbol: {
          name: word,
          kind: "Variable" as const,
          file: m.file,
          line: m.line,
          column: m.column,
          parent: null,
        },
        confidence: "Semantic" as const,
        score: null,
      }));
    } catch {
      results.value = [];
    }
  }

  function dismiss() {
    visible.value = false;
    results.value = [];
    selectedIndex.value = 0;
  }

  function selectPrev() {
    if (results.value.length === 0) return;
    selectedIndex.value =
      (selectedIndex.value - 1 + results.value.length) % results.value.length;
  }

  function selectNext() {
    if (results.value.length === 0) return;
    selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
  }

  function getSelected(): QueryResult | null {
    if (results.value.length === 0) return null;
    return results.value[selectedIndex.value] ?? null;
  }

  async function searchAllReferences(word: string, projectRoot: string) {
    if (!word || !projectRoot) return;

    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    results.value = [];
    selectedIndex.value = 0;
    visible.value = true;

    // Try CodeGraph with broader scope (no current-file filter)
    try {
      const cgResults = await api.codegraphGotoDefinition(
        word, "", 0, 0, projectRoot,
      );
      if (cgResults.length > 0) {
        results.value = cgResults;
        return;
      }
    } catch { /* fall through */ }

    // Fallback to grep
    isGrepFallback.value = true;
    try {
      const matches = await api.grepSymbol(word, projectRoot, lastSourceExt || undefined);
      results.value = matches.map(m => ({
        symbol: {
          name: word,
          kind: "Variable" as const,
          file: m.file,
          line: m.line,
          column: m.column,
          parent: null,
        },
        confidence: "Semantic" as const,
        score: null,
      }));
    } catch {
      results.value = [];
    }
  }

  return {
    visible: readonly(visible),
    results: readonly(results),
    selectedIndex: readonly(selectedIndex),
    searchWord: readonly(searchWord),
    isGrepFallback: readonly(isGrepFallback),
    search,
    searchAllReferences,
    dismiss,
    selectPrev,
    selectNext,
    getSelected,
    getProjectRoot: () => lastProjectRoot,
  };
}
```

- [ ] **Step 2: Verify compilation**

```bash
cd src && npx vue-tsc --noEmit 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git add src/composables/useGotoDefinition.ts
git commit -m "feat(codegraph): upgrade useGotoDefinition — CodeGraph + grep fallback

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: FileWindow inline jump trigger + result UI

**Files:**
- Modify: `src/components/fileviewer/FileWindow.vue`
- Check: Existing goto popover component (if separate) or modify inline

**Interfaces:**
- Consumes: Updated `useGotoDefinition` (QueryResult-based)
- Produces: Cmd/Ctrl+Click handler on symbol-like tokens; single-result → direct jump, multi-result → popover with confidence labels

- [ ] **Step 1: Add confidence badge to existing goto popover**

Find the goto popover template in FileWindow.vue (or its parent). The popover renders `results` from `useGotoDefinition`. Update each result row to show a confidence badge.

Locate the result rendering template (currently shows `GrepMatch`). Update to show `QueryResult` with badge:

```html
<!-- Inside the goto popover result list -->
<div
  v-for="(item, idx) in results"
  :key="`${item.symbol.file}:${item.symbol.line}:${idx}`"
  class="goto-result-item"
  :class="{ selected: idx === selectedIndex }"
  @click="jumpToResult(item)"
  @mouseenter="selectedIndex = idx"
>
  <span class="goto-confidence" :class="item.confidence === 'Structure' ? 'conf-structure' : 'conf-semantic'">
    {{ item.confidence === 'Structure' ? '[精确]' : `[语义·${item.score != null ? Math.round(item.score * 100) : '?'}%]` }}
  </span>
  <span class="goto-name">{{ item.symbol.name }}</span>
  <span v-if="item.symbol.parent" class="goto-parent">· {{ item.symbol.parent }}</span>
  <span class="goto-file">{{ item.symbol.file }}:{{ item.symbol.line }}</span>
</div>
```

Add styles for confidence badges (non-scoped block if the popover is xterm/teleported):

```css
.goto-confidence { font-size: 11px; margin-right: 6px; flex-shrink: 0; }
.conf-structure { color: #a6e3a1; }  /* green — exact */
.conf-semantic { color: #f9e2af; }   /* yellow — semantic guess */
```

- [ ] **Step 2: Add jumpToResult function**

Add to FileWindow.vue script:

```typescript
function jumpToResult(item: QueryResult) {
  goto.dismiss();
  const fullPath = item.symbol.file;
  openAndScrollTo(fullPath, item.symbol.line);
}
```

- [ ] **Step 3: Wire Cmd/Ctrl+Click in CodeEditor**

The CodeEditor component (`src/components/CodeEditor.vue`) needs to expose a click handler. Check if it supports `@click` on token level. If not, add a document-level click listener in FileWindow that detects Cmd/Ctrl+Click on the code editor container and extracts the word under cursor.

In FileWindow.vue `onMounted`:

```typescript
onMounted(() => {
  const editorEl = codeEditorRef.value?.$el;
  if (!editorEl) return;

  editorEl.addEventListener('click', (e: MouseEvent) => {
    if (!e.metaKey && !e.ctrlKey) return; // only Cmd/Ctrl+Click
    e.preventDefault();

    const word = getWordAtClick(e);
    if (!word || word.length < 2) return;

    const line = getLineNumberAtClick(e);
    const filePath = props.win.filePath;
    const root = projectRoot.value;
    if (!root) return;

    goto.search(word, root, {
      sourceFile: filePath,
      sourceLine: line,
      sourceExt: filePath.split('.').pop() || '',
    });

    // If exactly one result arrives, jump directly (watch results)
    const unwatch = watch(
      () => goto.results.value,
      (res) => {
        if (res.length === 1) {
          jumpToResult(res[0]);
        }
        unwatch();
      },
      { flush: 'post' },
    );
  });
});

function getWordAtClick(e: MouseEvent): string | null {
  const range = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!range) return null;
  // Expand to word boundaries
  const text = range.startContainer.textContent || '';
  let start = range.startOffset;
  let end = range.startOffset;
  const wordRe = /\w/;
  while (start > 0 && wordRe.test(text[start - 1])) start--;
  while (end < text.length && wordRe.test(text[end])) end++;
  const word = text.slice(start, end);
  return word || null;
}

function getLineNumberAtClick(e: MouseEvent): number {
  // Approximate: count newlines before click position in editor
  const editorEl = codeEditorRef.value?.$el;
  if (!editorEl) return 0;
  const rect = editorEl.getBoundingClientRect();
  const lineHeight = 20; // approximate CodeMirror line height
  return Math.floor((e.clientY - rect.top) / lineHeight) + 1;
}
```

- [ ] **Step 4: Verify frontend compiles**

```bash
cd src && npx vue-tsc --noEmit 2>&1 | tail -15
```

- [ ] **Step 5: Commit**

```bash
git add src/components/fileviewer/FileWindow.vue
git commit -m "feat(codegraph): add inline Cmd+Click jump + confidence badges in popover

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: SearchProvider registration

**Files:**
- Modify: `src/composables/useSearchProviders.ts` (or create new provider file)

- [ ] **Step 1: Register CodeGraph search provider**

In the file where search providers are registered (likely `useSearchProviders.ts` or the file that calls `register()`), add a CodeGraph provider. If providers are registered in a setup function, add there:

```typescript
// CodeGraph symbol search provider
register({
  id: "codegraph",
  label: "符号",
  priority: 5, // after sessions, before files
  async search(query: string, limit: number): Promise<SearchResult[]> {
    if (!query.trim() || query.trim().length < 2) return [];
    // Get current project root from active session or workspace
    const projectRoot = /* get from context — may need to thread through */ "";
    if (!projectRoot) return [];

    try {
      const results = await api.codegraphGotoDefinition(
        query, "", 0, 0, projectRoot,
      );
      return results.slice(0, limit).map((r) => ({
        id: `${r.symbol.file}:${r.symbol.line}:${r.symbol.name}`,
        label: r.symbol.name,
        description: `${r.confidence === "Structure" ? "精确" : "语义"} · ${r.symbol.file}:${r.symbol.line}`,
        icon: r.confidence === "Structure" ? "🔗" : "🔍",
        action() {
          // Jump to file — dynamic import (top-level imports not accessible in inline callbacks)
          import("../../composables/useFileViewer").then(({ useFileViewer }) => {
            useFileViewer().openAndScrollTo(r.symbol.file, r.symbol.line);
          });
        },
      }));
    } catch {
      return [];
    }
  },
});
```

Note: The project root needs to be accessible from the provider. If the existing providers don't need it, add as a module-level variable or get from workspace state. Alternatively, skip the SearchProvider for now and defer to a follow-up if project root threading is non-trivial — the inline jump (Task 11) is the primary user-facing feature.

- [ ] **Step 2: Verify frontend compiles**

```bash
cd src && npx vue-tsc --noEmit 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git add src/composables/useSearchProviders.ts
git commit -m "feat(codegraph): register CodeGraph symbol search provider

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Integration smoke test

- [ ] **Step 1: Build check**

```bash
cd src-tauri && cargo check -p aide 2>&1 | tail -5
```

Expected: No errors.

- [ ] **Step 2: Run dev**

```bash
pnpm tauri dev
```

Manual smoke test:
1. Open a Java or TypeScript project
2. Open a file in the editor
3. Cmd/Ctrl+Click a method name — popover should appear
4. Click a result — should jump to definition
5. Verify grep fallback: rename `.aide/index/` to disable codegraph, repeat — should still work via grep

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore(codegraph): integration smoke test fixups

Co-Authored-By: Claude <noreply@anthropic.com>"
```
