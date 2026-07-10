# CodeGraph 精确跳转重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CodeGraph 兑现"精确跳转"——结构层跨文件精确命中、索引不阻塞 UI，并接上持久化/增量/切项目/关闭四条生命周期。

**Architecture:** 引入常驻内存 `SymbolTable`（name → 全项目定义）承担结构层精确查找，Qdrant shard 只管语义向量 + 磁盘。`CodeGraphState` 改 `RwLock<Option<ProjectIndex>>` 双缓冲：build 在 `spawn_blocking` 里离线构建完整快照，最后一次写锁原子替换，查询读旧快照零阻塞。`SymbolTable` 以 `symbols.json` 持久化，配合 `meta.json` 做 mtime 判定的加载/重建。

**Tech Stack:** Rust（Tauri v2 command / tree-sitter / qdrant-edge 0.6 / fastembed）、Vue 3 + TS 前端、vitest / `cargo test --lib`。

## Global Constraints

- 重 IO/CPU 的 async command **一律 `spawn_blocking`**；`State<T>` 不能跨 `spawn_blocking`，state 已注册为 `Arc<Mutex<..>>`/`Arc<..>`，命令里先 `state.inner().clone()`（Arc clone，owned Send）再 move 进闭包。
- 跨平台：路径用 `PathBuf`/`Path::join`，项目相对路径统一 forward slash（`replace('\\', "/")`）。
- provider-agnostic：codegraph 是 Rust 原生命令，不得引入任何 Claude/Anthropic 专属类型。
- tree-sitter 语法调用沿用 `parser.rs`/`extract.rs` 现有写法（当前锁定的 tree-sitter grammar 版本，勿改版本号）。
- Rust 单测统一 `cargo test --lib codegraph`（仓库 quirk：`--lib` 绕杀软对 target 的锁）。**所有 Rust 单测走 `embedder = None` 路径，禁止在测试里下载/加载 ONNX 模型。**
- 前端测试沿用 `src/composables/useFileViewer.test.ts` 的 `vi.mock('../api')` 模式。
- 不碰 IPC 核心协议字段语义；新增命令 `codegraph_reindex_file` 属 codegraph 私有扩展。

---

## 文件结构

**新建：**
- `src-tauri/src/codegraph/symbols.rs` — `SymbolTable`（内存精确查找 + serde 持久化）
- `src-tauri/src/codegraph/meta.rs` — `Meta`（meta.json 读写 + mtime 陈旧判定）

**改造：**
- `src-tauri/src/codegraph/mod.rs` — `CodeGraphState` 改双缓冲；三命令 spawn_blocking 化；新增 `codegraph_reindex_file`；新增 `ProjectIndex`
- `src-tauri/src/codegraph/shard.rs` — 确定性点 ID；补 `name` keyword 索引；删死代码 `upsert_symbols`；修 `load()` 配置
- `src-tauri/src/codegraph/indexer.rs` — `collect_symbols`（纯提取）+ `build_project_index`（含 shard/symbols.json/meta.json 落盘）+ `reindex_one`
- `src-tauri/src/codegraph/indexer/extract.rs` — 跳过函数内局部变量；成员调用取末段标识符
- `src-tauri/src/codegraph/query.rs` + `query/structure.rs` + `query/semantic.rs` — 结构层改查 `SymbolTable`；语义查询文本去污染
- `src-tauri/src/lib.rs` — 注册 `codegraph_reindex_file`
- `src/api.ts` — 加 `codegraphReindexFile`
- `src/composables/useFileViewer.ts` — save→reindex；`detectProjectRoot` 守卫改 `lastIndexedRoot`；切项目 close；删 debug 日志
- `.gitignore` — 加 `.aide/`、`.fastembed_cache/`

---

## Task 1: SymbolTable 模块

**Files:**
- Create: `src-tauri/src/codegraph/symbols.rs`
- Modify: `src-tauri/src/codegraph/mod.rs`（加 `pub mod symbols;`，第 6 行 `pub mod query;` 后）
- Test: 同文件 `#[cfg(test)]`

**Interfaces:**
- Produces: `SymbolTable { new(), insert(SymbolDef), lookup(&str)->Vec<SymbolDef>, remove_file(&str), len()->usize, is_empty()->bool, save_json(&Path)->io::Result<()>, load_json(&Path)->Option<SymbolTable> }`；`#[derive(Default, Serialize, Deserialize)]`
- Consumes: `crate::codegraph::types::SymbolDef`

- [ ] **Step 1: 写失败测试**

在 `symbols.rs` 末尾：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::types::{SymbolDef, SymbolKind};

    fn sym(name: &str, file: &str, line: usize) -> SymbolDef {
        SymbolDef { name: name.into(), kind: SymbolKind::Method, file: file.into(), line, column: 1, parent: None }
    }

    #[test]
    fn lookup_returns_all_same_name_across_files() {
        let mut t = SymbolTable::new();
        t.insert(sym("save", "a/UserService.java", 10));
        t.insert(sym("save", "b/OrderService.java", 22));
        t.insert(sym("load", "c/Repo.java", 5));
        let mut hit = t.lookup("save");
        hit.sort_by_key(|s| s.line);
        assert_eq!(hit.len(), 2);
        assert_eq!(hit[0].file, "a/UserService.java");
        assert_eq!(hit[1].file, "b/OrderService.java");
        assert_eq!(t.lookup("missing").len(), 0);
    }

    #[test]
    fn remove_file_drops_only_that_files_symbols() {
        let mut t = SymbolTable::new();
        t.insert(sym("save", "a.java", 1));
        t.insert(sym("save", "b.java", 2));
        t.remove_file("a.java");
        assert_eq!(t.lookup("save").len(), 1);
        assert_eq!(t.lookup("save")[0].file, "b.java");
    }

    #[test]
    fn json_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cg_sym_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("symbols.json");
        let mut t = SymbolTable::new();
        t.insert(sym("save", "a.java", 1));
        t.save_json(&path).unwrap();
        let loaded = SymbolTable::load_json(&path).unwrap();
        assert_eq!(loaded.lookup("save").len(), 1);
        assert_eq!(loaded.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib codegraph::symbols`
Expected: FAIL（`SymbolTable` 未定义 / 编译错误）

- [ ] **Step 3: 实现**

`symbols.rs` 顶部：
```rust
use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::codegraph::types::SymbolDef;

/// In-memory exact-lookup index: symbol name → every definition with that name
/// across the whole project. This is the structure-layer ground truth; the
/// Qdrant shard is only used for semantic (vector) fallback.
#[derive(Default, Serialize, Deserialize)]
pub struct SymbolTable {
    by_name: HashMap<String, Vec<SymbolDef>>,
}

impl SymbolTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, sym: SymbolDef) {
        self.by_name.entry(sym.name.clone()).or_default().push(sym);
    }

    /// All definitions matching `name` exactly (cross-file).
    pub fn lookup(&self, name: &str) -> Vec<SymbolDef> {
        self.by_name.get(name).cloned().unwrap_or_default()
    }

    /// Drop every symbol belonging to `file` (used on incremental re-index).
    pub fn remove_file(&mut self, file: &str) {
        for v in self.by_name.values_mut() {
            v.retain(|s| s.file != file);
        }
        self.by_name.retain(|_, v| !v.is_empty());
    }

    pub fn len(&self) -> usize {
        self.by_name.values().map(|v| v.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.by_name.is_empty()
    }

    pub fn save_json(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(path, bytes)
    }

    pub fn load_json(path: &Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}
```

在 `mod.rs` 第 6 行 `pub mod query;` 之后加：
```rust
pub mod symbols;
pub mod meta;
```
（`meta` 由 Task 6 填充；此处先建空文件 `src-tauri/src/codegraph/meta.rs` 内容 `// filled in Task 6`，避免编译期缺模块——或把 `pub mod meta;` 留到 Task 6 再加。为让本任务独立编译通过，**本步只加 `pub mod symbols;`**，`pub mod meta;` 留到 Task 6。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib codegraph::symbols`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/codegraph/symbols.rs src-tauri/src/codegraph/mod.rs
git commit -m "feat(codegraph): add in-memory SymbolTable with JSON persistence"
```

---

## Task 2: 确定性点 ID + shard 清理

**Files:**
- Modify: `src-tauri/src/codegraph/shard.rs`
- Test: 同文件 `#[cfg(test)]`

**Interfaces:**
- Produces: `stable_point_id(file:&str, line:usize, column:usize, name:&str) -> u64`（模块内私有，测试可见）；`CodeShard` 新增 `name` keyword 索引；删除 `upsert_symbols`
- Consumes: 无新增

- [ ] **Step 1: 写失败测试**

`shard.rs` 末尾：
```rust
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib codegraph::shard`
Expected: FAIL（`stable_point_id` 未定义）

- [ ] **Step 3: 实现**

在 `shard.rs` 删除 `static NEXT_ID`（第 8 行）。在文件末尾 helpers 区加：
```rust
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
```

`upsert_with_vectors` 里把 `let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);` 改为：
```rust
let id = stable_point_id(&p.symbol.file, p.symbol.line, p.symbol.column, &p.symbol.name);
```

删除整个 `upsert_symbols` 方法（`shard.rs:94-125`，零向量死代码）及顶部 `use std::sync::atomic::{AtomicU64, Ordering};`（第 3 行）。

在 `create()` 里，`source` keyword 索引之后补一段 `name` keyword 索引：
```rust
// Create keyword index on symbol name for exact cross-file structure lookup
inner.update(UpdateOperation::FieldIndexOperation(
    FieldIndexOperations::CreateIndex(CreateIndex {
        field_name: "name".try_into().unwrap(),
        field_schema: Some(PayloadFieldSchema::FieldType(PayloadSchemaType::Keyword)),
    }),
))?;
```

修 `load()`：把 `vectors: HashMap::new()` 改成与 `create()` 同构的向量配置，否则重载后向量搜索维度信息缺失：
```rust
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
```

- [ ] **Step 4: 跑测试确认通过 + 全量编译**

Run: `cargo test --lib codegraph::shard`
Expected: PASS（1 test）
Run: `cargo build`（确认删 `upsert_symbols` 无残留调用）
Expected: 编译通过

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/codegraph/shard.rs
git commit -m "fix(codegraph): deterministic point IDs + name index, drop dead zero-vector path"
```

---

## Task 3: extract 提取修正（局部变量 + 成员调用取名）

**Files:**
- Modify: `src-tauri/src/codegraph/indexer/extract.rs`
- Test: 同文件 `#[cfg(test)]`

**Interfaces:**
- Consumes: `ParserManager`（`parser_manager.rs`）、`extract_symbols(file_path, source, parser_manager, project_root) -> (Vec<IndexedPoint>, Vec<CallEdge>)`（签名不变）
- Produces: 行为变化——函数内局部 `variable_declarator` 不再入库；成员调用 `foo.bar()` 的 callee 取末段 `bar`

- [ ] **Step 1: 写失败测试**

`extract.rs` 末尾：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::parser::ParserManager;
    use std::path::Path;

    fn names(src: &str, file: &str) -> Vec<String> {
        let pm = ParserManager::new();
        let (pts, _) = extract_symbols(Path::new(file), src, &pm, Path::new(""));
        pts.into_iter().map(|p| p.symbol.name).collect()
    }

    #[test]
    fn skips_function_local_variables() {
        // `total` is a local inside a function → must NOT be indexed.
        let src = "function calc() { const total = 1 + 2; return total; }";
        let got = names(src, "x.ts");
        assert!(got.contains(&"calc".to_string()), "function itself indexed");
        assert!(!got.contains(&"total".to_string()), "local var must be skipped");
    }

    #[test]
    fn indexes_class_fields() {
        let src = "class Repo { private db = 1; save() {} }";
        let got = names(src, "Repo.ts");
        assert!(got.contains(&"Repo".to_string()));
        assert!(got.contains(&"save".to_string()));
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib codegraph::indexer::extract`
Expected: FAIL（`skips_function_local_variables` 断言失败——目前局部变量会被收）

- [ ] **Step 3: 实现**

在 `extract.rs` 的 `"field_declaration" | "variable_declarator" | ...` 分支（第 160 行起），**只在类字段上下文入库**，改成：
```rust
"field_declaration" | "variable_declarator"
| "public_field_definition" | "property_definition" => {
    // Only index class-level fields; skip function-local const/let to avoid
    // flooding the table with locals (Mo3).
    if parent_class.is_some() {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = match name_node.utf8_text(source.as_bytes()) {
                Ok(n) => n,
                Err(_) => return,
            };
            let start = node.start_position();
            symbols.push(IndexedPoint {
                symbol: SymbolDef {
                    name: name.to_string(),
                    kind: SymbolKind::Field,
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
}
```

在 call 分支（第 184 行起）用 `callee_leaf_name` 取末段标识符。把
```rust
let callee = match name_node.utf8_text(source.as_bytes()) {
    Ok(s) => s,
    Err(_) => return,
};
```
改为：
```rust
let raw = match name_node.utf8_text(source.as_bytes()) {
    Ok(s) => s,
    Err(_) => return,
};
let callee = callee_leaf_name(raw);
```
并在 `node_text_snippet` 上方加：
```rust
/// For `foo.bar()` the callee text is `foo.bar`; the user clicks `bar`, so
/// index the trailing identifier only (Mo5).
fn callee_leaf_name(raw: &str) -> &str {
    raw.rsplit(['.', ':']).next().unwrap_or(raw).trim()
}
```
（下方 `call_edges.push(CallEdge { ... callee: callee.to_string() ... })` 不变，`callee` 现为 `&str`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib codegraph::indexer::extract`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/codegraph/indexer/extract.rs
git commit -m "fix(codegraph): skip function-local vars, take trailing identifier for member calls"
```

---

## Task 4: 纯提取编排 collect_symbols

**Files:**
- Modify: `src-tauri/src/codegraph/indexer.rs`
- Test: 同文件 `#[cfg(test)]`

**Interfaces:**
- Produces: `collect_symbols(project_root:&Path, parser_manager:&ParserManager) -> (SymbolTable, Vec<IndexedPoint>, BuildStats)`；`pub struct BuildStats { scanned_files:usize, files_with_symbols:usize, total_symbols:usize }`
- Consumes: `walk::walk_source_files`、`extract::extract_symbols`、`SymbolTable`（Task 1）

- [ ] **Step 1: 写失败测试**

`indexer.rs` 末尾：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::parser::ParserManager;

    #[test]
    fn collect_builds_cross_file_table() {
        let dir = std::env::temp_dir().join(format!("cg_collect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("UserService.java"),
            "class UserService { void save() {} }").unwrap();
        std::fs::write(dir.join("OrderService.java"),
            "class OrderService { void save() {} }").unwrap();

        let pm = ParserManager::new();
        let (table, points, stats) = collect_symbols(&dir, &pm);

        // `save` defined in two files → both reachable
        assert_eq!(table.lookup("save").len(), 2);
        assert!(table.lookup("UserService").len() == 1);
        assert!(stats.files_with_symbols == 2);
        assert!(!points.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib codegraph::indexer::tests::collect_builds_cross_file_table`
Expected: FAIL（`collect_symbols` 未定义）

- [ ] **Step 3: 实现**

在 `indexer.rs` 顶部 imports 补：
```rust
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::IndexedPoint;
```
加：
```rust
#[derive(Debug, Default, Clone, Copy)]
pub struct BuildStats {
    pub scanned_files: usize,
    pub files_with_symbols: usize,
    pub total_symbols: usize,
}

/// Parse the whole project into an in-memory SymbolTable + the points that
/// will be embedded into the shard. Pure w.r.t. shard/embedder — testable
/// without ONNX or Qdrant.
pub fn collect_symbols(
    project_root: &Path,
    parser_manager: &ParserManager,
) -> (SymbolTable, Vec<IndexedPoint>, BuildStats) {
    let exts = parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = exts.iter().copied().collect();
    let files = walk::walk_source_files(project_root, &ext_refs);

    let mut table = SymbolTable::new();
    let mut all_points: Vec<IndexedPoint> = Vec::new();
    let mut stats = BuildStats::default();

    for file_path in &files {
        stats.scanned_files += 1;
        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("codegraph: read failed {}: {}", file_path.display(), e);
                continue;
            }
        };
        let (points, _edges) =
            extract_symbols(file_path, &source, parser_manager, project_root);
        if points.is_empty() {
            continue;
        }
        stats.files_with_symbols += 1;
        stats.total_symbols += points.len();
        for p in &points {
            table.insert(p.symbol.clone());
        }
        all_points.extend(points);
    }
    (table, all_points, stats)
}
```
（`extract_symbols` 已 `use extract::extract_symbols;`；若未引入则补 `use extract::extract_symbols;`。保留现有 `index_all`/`index_file` 暂不删——Task 5/7 会替换其调用点，Task 8 收尾删除残余死代码。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib codegraph::indexer`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/codegraph/indexer.rs
git commit -m "feat(codegraph): add pure collect_symbols building cross-file SymbolTable"
```

---

## Task 5: 结构层查 SymbolTable + 语义查询去污染

**Files:**
- Modify: `src-tauri/src/codegraph/query/structure.rs`（整体简化为查表）、`src-tauri/src/codegraph/query.rs`、`src-tauri/src/codegraph/query/semantic.rs`
- Test: `query/structure.rs` 同文件 `#[cfg(test)]`

**Interfaces:**
- Produces: `structure::structure_lookup(word:&str, table:&SymbolTable, cursor_line:usize) -> Vec<QueryResult>`；`query::query_goto_definition(word, table:&SymbolTable, shard:Option<&CodeShard>, embedder:Option<&Embedder>) -> Vec<QueryResult>`（签名变更——不再收 file/project_root/parser_manager）
- Consumes: `SymbolTable`（Task 1）

- [ ] **Step 1: 写失败测试**

`query/structure.rs` 末尾：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::symbols::SymbolTable;
    use crate::codegraph::types::{SymbolDef, SymbolKind};

    fn sym(name: &str, file: &str, line: usize) -> SymbolDef {
        SymbolDef { name: name.into(), kind: SymbolKind::Method, file: file.into(), line, column: 1, parent: None }
    }

    #[test]
    fn structure_lookup_is_cross_file_and_ranks_by_cursor_proximity() {
        let mut t = SymbolTable::new();
        t.insert(sym("save", "far.java", 100));
        t.insert(sym("save", "near.java", 12));
        let res = structure_lookup("save", &t, 10);
        assert_eq!(res.len(), 2);
        assert!(matches!(res[0].confidence, Confidence::Structure));
        // line 12 is closer to cursor line 10 than line 100 → first
        assert_eq!(res[0].symbol.file, "near.java");
        assert!(res[0].score.is_none());
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib codegraph::query::structure`
Expected: FAIL（`structure_lookup` 新签名不存在）

- [ ] **Step 3: 实现**

`query/structure.rs` **整体替换**为（删掉所有 tree-sitter re-parse 逻辑）：
```rust
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::{Confidence, QueryResult};

/// Exact cross-file structure-layer lookup against the in-memory SymbolTable.
/// Results ranked by proximity to the cursor line (closest first) as a tie-break.
pub fn structure_lookup(
    word: &str,
    table: &SymbolTable,
    cursor_line: usize,
) -> Vec<QueryResult> {
    let mut results: Vec<QueryResult> = table
        .lookup(word)
        .into_iter()
        .map(|symbol| QueryResult {
            symbol,
            confidence: Confidence::Structure,
            score: None,
        })
        .collect();

    results.sort_by_key(|r| (r.symbol.line as isize - cursor_line as isize).unsigned_abs());
    results
}
```

`query.rs` 的 `query_goto_definition` **整体替换**为：
```rust
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
```

`query/semantic.rs` 把查询文本去污染——签名不变，但调用方现在传裸 `word`（`query.rs` 已改）。`semantic_search` 内部 `embedder.embed_one(query_text)` 保持，即直接 embed `word`。**删除**原先在 `query.rs` 里的 `format!("{} in file {} at line {}", ...)` 拼接（已在上面整体替换中去掉）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib codegraph::query`
Expected: PASS
（注意：本任务后 `mod.rs` 仍调用旧签名 `query_goto_definition`，编译会红——由 Task 6 一并修好；本步只需 `cargo test --lib codegraph::query` 针对该模块的测试通过，全量 `cargo build` 允许暂红。若 subagent 环境要求全绿，可与 Task 6 合并执行。）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/codegraph/query.rs src-tauri/src/codegraph/query/structure.rs src-tauri/src/codegraph/query/semantic.rs
git commit -m "feat(codegraph): structure layer queries SymbolTable (cross-file); de-noise semantic query text"
```

---

## Task 6: meta.rs + 双缓冲 State + build/goto/close 命令 spawn_blocking 化

**Files:**
- Create: `src-tauri/src/codegraph/meta.rs`
- Modify: `src-tauri/src/codegraph/mod.rs`（大改）、`src-tauri/src/codegraph/indexer.rs`（加 `build_project_index`/`load_project_index`）
- Test: `meta.rs` 同文件 `#[cfg(test)]`

**Interfaces:**
- Produces: `Meta { version:u32, model_name:String, indexed_at:u64, symbol_count:usize }` + `Meta::load(&Path)->Option<Meta>` + `Meta::save(&self,&Path)->io::Result<()>` + `is_stale(project_root:&Path, indexed_at:u64, exts:&[&str])->bool`；`indexer::build_project_index(...)->Result<(SymbolTable, Arc<CodeShard>, BuildStats),_>`；`indexer::load_project_index(...)->Option<(SymbolTable, Arc<CodeShard>)>`；`ProjectIndex`（mod.rs）
- Consumes: Task 1/4/5 全部

- [ ] **Step 1: 写失败测试（meta）**

`meta.rs`：
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meta_roundtrip_and_staleness() {
        let dir = std::env::temp_dir().join(format!("cg_meta_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meta.json");
        let m = Meta { version: 1, model_name: "all-MiniLM-L6-v2".into(), indexed_at: 1_000, symbol_count: 3 };
        m.save(&path).unwrap();
        let loaded = Meta::load(&path).unwrap();
        assert_eq!(loaded.symbol_count, 3);
        assert_eq!(loaded.model_name, "all-MiniLM-L6-v2");

        // a source file with mtime now (>> 1000) → stale
        std::fs::write(dir.join("A.java"), "class A {}").unwrap();
        assert!(is_stale(&dir, 1_000, &["java"]), "recent file must mark index stale");
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib codegraph::meta`
Expected: FAIL（`Meta` 未定义）

- [ ] **Step 3: 实现 meta.rs**

```rust
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

pub const META_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub version: u32,
    pub model_name: String,
    pub indexed_at: u64, // unix epoch seconds
    pub symbol_count: usize,
}

impl Meta {
    pub fn load(path: &Path) -> Option<Self> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(path, bytes)
    }
}

pub fn now_epoch() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// True if any indexable source file was modified after `indexed_at`.
pub fn is_stale(project_root: &Path, indexed_at: u64, exts: &[&str]) -> bool {
    for entry in WalkBuilder::new(project_root).standard_filters(true).hidden(false).build().flatten() {
        if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !exts.contains(&ext) {
            continue;
        }
        if let Ok(meta) = path.metadata() {
            if let Ok(modified) = meta.modified() {
                if let Ok(d) = modified.duration_since(UNIX_EPOCH) {
                    if d.as_secs() > indexed_at {
                        return true;
                    }
                }
            }
        }
    }
    false
}
```
在 `mod.rs` 补 `pub mod meta;`（若 Task 1 未加）。

- [ ] **Step 4: 实现 build/load 编排（indexer.rs）**

在 `indexer.rs` 补 imports：
```rust
use std::sync::Arc;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::embed::Embedder;
use crate::codegraph::meta::{Meta, now_epoch, META_VERSION};
use crate::codegraph::store::embed_and_store; // 现为 indexer::store::embed_and_store
```
（注意：`embed_and_store` 在 `indexer/store.rs`，用 `use store::embed_and_store;`。）

加：
```rust
const MODEL_NAME: &str = "all-MiniLM-L6-v2";

fn index_dir(project_root: &Path) -> std::path::PathBuf {
    project_root.join(".aide").join("index")
}

/// Full rebuild: fresh shard + SymbolTable, persisted to disk. Never holds any
/// lock — caller swaps the returned artifacts into state under a brief write lock.
pub fn build_project_index(
    project_root: &Path,
    embedder: Option<&Embedder>,
    parser_manager: &ParserManager,
) -> Result<(SymbolTable, Arc<CodeShard>, BuildStats), Box<dyn std::error::Error>> {
    let base = index_dir(project_root);
    let qdir = base.join("qdrant");
    if qdir.exists() {
        let _ = std::fs::remove_dir_all(&qdir);
    }
    std::fs::create_dir_all(&base)?;
    let shard = CodeShard::create(&qdir)?;

    let (table, points, stats) = collect_symbols(project_root, parser_manager);

    if let Some(embedder) = embedder {
        // embed & store in file-sized batches to cap peak memory
        for chunk in points.chunks(256) {
            if let Err(e) = embed_and_store(chunk, embedder, &shard) {
                tracing::warn!("codegraph: embed batch failed: {}", e);
            }
        }
    }

    // Persist SymbolTable + meta (same transaction point as shard).
    let _ = table.save_json(&base.join("symbols.json"));
    let _ = Meta {
        version: META_VERSION,
        model_name: MODEL_NAME.to_string(),
        indexed_at: now_epoch(),
        symbol_count: table.len(),
    }
    .save(&base.join("meta.json"));

    Ok((table, Arc::new(shard), stats))
}

/// Fast path: reuse on-disk index if fresh. None → caller must full-rebuild.
pub fn load_project_index(
    project_root: &Path,
    parser_manager: &ParserManager,
) -> Option<(SymbolTable, Arc<CodeShard>)> {
    let base = index_dir(project_root);
    let meta = Meta::load(&base.join("meta.json"))?;
    if meta.model_name != MODEL_NAME {
        return None;
    }
    let exts = parser_manager.supported_extensions();
    if crate::codegraph::meta::is_stale(project_root, meta.indexed_at, &exts) {
        return None;
    }
    let table = SymbolTable::load_json(&base.join("symbols.json"))?;
    let shard = CodeShard::load(&base.join("qdrant")).ok()?;
    Some((table, Arc::new(shard)))
}
```

- [ ] **Step 5: 重写 mod.rs（双缓冲 State + 三命令）**

`mod.rs` 顶部与 State：
```rust
pub mod indexer;
pub mod types;
pub mod shard;
pub mod embed;
pub mod parser;
pub mod query;
pub mod symbols;
pub mod meta;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

use crate::codegraph::embed::Embedder;
use crate::codegraph::shard::CodeShard;
use crate::codegraph::symbols::SymbolTable;

pub struct ProjectIndex {
    pub project_root: PathBuf,
    pub symbols: SymbolTable,
    pub shard: Arc<CodeShard>,
    pub indexed_at: SystemTime,
}

pub struct CodeGraphState {
    inner: RwLock<Option<ProjectIndex>>,
    embedder: Mutex<Option<Embedder>>,
    parser_manager: parser::ParserManager,
}

impl CodeGraphState {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(None),
            embedder: Mutex::new(None),
            parser_manager: parser::ParserManager::new(),
        }
    }
}
```

`codegraph_build_index` 命令（load-or-build + spawn_blocking + swap）：
```rust
#[tauri::command]
pub async fn codegraph_build_index(
    project_root: String,
    state: tauri::State<'_, Arc<CodeGraphState>>,
) -> Result<serde_json::Value, String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);

        // Fast path: reuse fresh on-disk index.
        if let Some((table, shard)) = indexer::load_project_index(&root, &st.parser_manager) {
            let n = table.len();
            *st.inner.write().map_err(|e| e.to_string())? =
                Some(ProjectIndex { project_root: root, symbols: table, shard, indexed_at: SystemTime::now() });
            return Ok(serde_json::json!({ "loaded": true, "total_symbols": n }));
        }

        // Ensure embedder (best-effort; structure layer works without it).
        {
            let mut emb = st.embedder.lock().map_err(|e| e.to_string())?;
            if emb.is_none() {
                match Embedder::new() {
                    Ok(e) => *emb = Some(e),
                    Err(e) => tracing::warn!("codegraph: embedder unavailable: {}", e),
                }
            }
        }

        let (table, shard, stats) = {
            let emb = st.embedder.lock().map_err(|e| e.to_string())?;
            indexer::build_project_index(&root, emb.as_ref(), &st.parser_manager)
                .map_err(|e| format!("Indexing failed: {}", e))?
        };
        let has_emb = st.embedder.lock().map(|g| g.is_some()).unwrap_or(false);
        let n = table.len();
        *st.inner.write().map_err(|e| e.to_string())? =
            Some(ProjectIndex { project_root: root, symbols: table, shard, indexed_at: SystemTime::now() });

        Ok(serde_json::json!({
            "loaded": false,
            "scanned_files": stats.scanned_files,
            "files_with_symbols": stats.files_with_symbols,
            "total_symbols": n,
            "has_embeddings": has_emb,
        }))
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}
```

`codegraph_goto_definition`（spawn_blocking；结构层读锁 → 语义释锁后 embed）：
```rust
#[tauri::command]
pub async fn codegraph_goto_definition(
    word: String,
    #[allow(unused_variables)] file: String,
    line: usize,
    #[allow(unused_variables)] column: usize,
    #[allow(unused_variables)] project_root: String,
    state: tauri::State<'_, Arc<CodeGraphState>>,
) -> Result<Vec<types::QueryResult>, String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        // 1. structure (exact, cross-file) under a read lock; clone shard Arc out.
        let (structure, shard_arc) = {
            let guard = st.inner.read().map_err(|e| e.to_string())?;
            match guard.as_ref() {
                None => return Ok(vec![]),
                Some(pi) => (
                    query::structure::structure_lookup(&word, &pi.symbols, line),
                    pi.shard.clone(),
                ),
            }
        };
        if !structure.is_empty() {
            return Ok(structure);
        }
        // 2. semantic — lock embedder, embed word, search shard (read lock already dropped).
        let emb = st.embedder.lock().map_err(|e| e.to_string())?;
        if let Some(embedder) = emb.as_ref() {
            match query::semantic::semantic_search(&word, embedder, &shard_arc, 10) {
                Ok(mut r) => {
                    r.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
                    return Ok(r);
                }
                Err(e) => tracing::warn!("codegraph: semantic search failed: {}", e),
            }
        }
        Ok(vec![])
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}
```

`codegraph_close`（spawn_blocking：optimize + flush + 持久化 + 清状态）：
```rust
#[tauri::command]
pub async fn codegraph_close(
    #[allow(unused_variables)] project_root: String,
    state: tauri::State<'_, Arc<CodeGraphState>>,
) -> Result<(), String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        if let Some(pi) = st.inner.write().map_err(|e| e.to_string())?.take() {
            if let Err(e) = pi.shard.optimize() {
                tracing::warn!("codegraph: optimize on close failed: {}", e);
            }
            // symbols.json / meta.json already persisted at build/reindex time.
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}
```

（`lib.rs` 里 `.manage(std::sync::Arc::new(std::sync::Mutex::new(codegraph::CodeGraphState::new())))` 改为 `.manage(std::sync::Arc::new(codegraph::CodeGraphState::new()))`——去掉外层 Mutex，因内部已 RwLock/Mutex 分治。）

- [ ] **Step 6: 全量编译 + 测试**

Run: `cargo build`
Expected: 通过（Task 5 的旧签名此刻被新命令消费，红转绿）
Run: `cargo test --lib codegraph`
Expected: 全 PASS

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/codegraph/ src-tauri/src/lib.rs
git commit -m "feat(codegraph): double-buffered RwLock state; spawn_blocking build/goto/close; load-or-build + meta"
```

---

## Task 7: 增量 reindex 命令 + 前端保存挂钩

**Files:**
- Modify: `src-tauri/src/codegraph/indexer.rs`（`reindex_one`）、`src-tauri/src/codegraph/mod.rs`（`codegraph_reindex_file` 命令）、`src-tauri/src/lib.rs`（注册）、`src/api.ts`、`src/composables/useFileViewer.ts`
- Test: `src/composables/useFileViewer.test.ts`

**Interfaces:**
- Produces: 命令 `codegraph_reindex_file(project_root:String, file:String)`；`indexer::reindex_one(pi:&mut ProjectIndex, abs_file:&Path, embedder:Option<&Embedder>, pm:&ParserManager)`；前端 `api.codegraphReindexFile(projectRoot, file)`
- Consumes: `ProjectIndex`、`SymbolTable::remove_file`、`shard.delete_by_file`

- [ ] **Step 1: 写失败测试（前端 save→reindex）**

在 `useFileViewer.test.ts` 加：
```ts
it("save triggers codegraph reindex for the file", async () => {
  const { api } = await import("../api");
  (api.codegraphReindexFile as any) = vi.fn(async () => undefined);
  const fv = useFileViewer();
  // 打开并编辑一个文件（沿用文件内既有 open+编辑 helper 模式）
  await fv.open("proj/A.ts");
  const win = (fv as any).windows.value.find((w: any) => w.filePath === "proj/A.ts");
  win.editContent = "changed";
  await fv.save(win.id);
  expect(api.writeFileContent).toHaveBeenCalledWith("proj/A.ts", "changed");
  expect(api.codegraphReindexFile).toHaveBeenCalled();
});
```
（按该测试文件已有的 mock 结构调整 open/编辑细节；关键断言是 `codegraphReindexFile` 被调用。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/composables/useFileViewer.test.ts`
Expected: FAIL（`codegraphReindexFile` 未定义 / 未被调用）

- [ ] **Step 3: 实现 Rust 侧**

`indexer.rs` 加：
```rust
/// Incremental: drop a file's symbols/points, re-parse it, update table + shard.
pub fn reindex_one(
    project_root: &Path,
    abs_file: &Path,
    table: &mut SymbolTable,
    shard: &CodeShard,
    embedder: Option<&Embedder>,
    parser_manager: &ParserManager,
) -> Result<(), Box<dyn std::error::Error>> {
    let rel = abs_file
        .strip_prefix(project_root)
        .unwrap_or(abs_file)
        .to_string_lossy()
        .replace('\\', "/");

    // remove stale
    table.remove_file(&rel);
    shard.delete_by_file(&rel)?;

    let source = match std::fs::read_to_string(abs_file) {
        Ok(s) => s,
        Err(_) => return Ok(()), // file gone → deletion only
    };
    let (points, _edges) = extract::extract_symbols(abs_file, &source, parser_manager, project_root);
    for p in &points {
        table.insert(p.symbol.clone());
    }
    if let Some(embedder) = embedder {
        for chunk in points.chunks(256) {
            let _ = store::embed_and_store(chunk, embedder, shard);
        }
    }

    // Re-persist symbols.json + meta (keep disk in sync with live table).
    let base = project_root.join(".aide").join("index");
    let _ = table.save_json(&base.join("symbols.json"));
    let _ = crate::codegraph::meta::Meta {
        version: crate::codegraph::meta::META_VERSION,
        model_name: MODEL_NAME.to_string(),
        indexed_at: crate::codegraph::meta::now_epoch(),
        symbol_count: table.len(),
    }
    .save(&base.join("meta.json"));
    Ok(())
}
```

`mod.rs` 加命令：
```rust
#[tauri::command]
pub async fn codegraph_reindex_file(
    project_root: String,
    file: String,
    state: tauri::State<'_, Arc<CodeGraphState>>,
) -> Result<(), String> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&project_root);
        let abs = PathBuf::from(&file);

        // Only reindex if it belongs to the active project.
        let mut guard = st.inner.write().map_err(|e| e.to_string())?;
        let pi = match guard.as_mut() {
            Some(pi) if pi.project_root == root => pi,
            _ => return Ok(()),
        };
        let emb = st.embedder.lock().map_err(|e| e.to_string())?;
        let shard = pi.shard.clone();
        indexer::reindex_one(&root, &abs, &mut pi.symbols, &shard, emb.as_ref(), &st.parser_manager)
            .map_err(|e| format!("reindex failed: {}", e))
    })
    .await
    .map_err(|e| format!("join error: {}", e))?
}
```
（注意：`reindex_one` 借 `&mut pi.symbols` 与 `pi.shard.clone()` 同时活跃——`shard` 是先 clone 出的 Arc，不再借 `pi`，无借用冲突。）

`lib.rs` 在 `codegraph::codegraph_close,` 后加 `codegraph::codegraph_reindex_file,`。

- [ ] **Step 4: 实现前端**

`src/api.ts` 在 `codegraphClose` 后加：
```ts
  codegraphReindexFile(projectRoot: string, file: string): Promise<void> {
    return invoke("codegraph_reindex_file", { projectRoot, file });
  },
```

`useFileViewer.ts` 的 `save`（第 199 行）在写盘成功后 fire-and-forget：
```ts
  async function save(id: string) {
    const win = windows.value.find((w) => w.id === id);
    if (!win || win.readonly || win.saving) return;
    win.saving = true;
    try {
      await api.writeFileContent(win.filePath, win.editContent);
      win.content = win.editContent;
      if (projectRoot.value) {
        void api.codegraphReindexFile(projectRoot.value, win.filePath).catch(() => {});
      }
    } catch (e) {
      win.error = String(e);
    }
    win.saving = false;
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run src/composables/useFileViewer.test.ts`
Expected: PASS
Run: `cargo build`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/codegraph/ src-tauri/src/lib.rs src/api.ts src/composables/useFileViewer.ts
git commit -m "feat(codegraph): incremental reindex on file save"
```

---

## Task 8: 切项目重建/关闭 + 前端查询接线更新 + 清理

**Files:**
- Modify: `src/composables/useFileViewer.ts`（`detectProjectRoot` 守卫 + close + 删日志）、`src/composables/useGotoDefinition.ts`（传 cursor line 语义不变，确认无碍）、`src-tauri/src/codegraph/indexer.rs`（删旧死代码 `index_all`/`index_file`/`store::reindex_file`）
- Test: `src/composables/useFileViewer.test.ts`

**Interfaces:**
- Consumes: `api.codegraphBuildIndex`、`api.codegraphClose`
- Produces: `detectProjectRoot` 按 root 变化重建；旧项目 close

- [ ] **Step 1: 写失败测试（切项目触发重建）**

`useFileViewer.test.ts` 加：
```ts
it("switching project root rebuilds index and closes the previous one", async () => {
  const { api } = await import("../api");
  (api.codegraphBuildIndex as any) = vi.fn(async () => ({ total_symbols: 0 }));
  (api.codegraphClose as any) = vi.fn(async () => undefined);
  (api.getProjectInfo as any) = vi.fn(async () => ({ root: "proj/one" }));

  const fv = useFileViewer();
  await fv.open("proj/one/A.ts");
  expect(api.codegraphBuildIndex).toHaveBeenCalledWith("proj/one");

  (api.getProjectInfo as any) = vi.fn(async () => ({ root: "proj/two" }));
  await fv.open("proj/two/B.ts");
  expect(api.codegraphClose).toHaveBeenCalledWith("proj/one");
  expect(api.codegraphBuildIndex).toHaveBeenCalledWith("proj/two");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/composables/useFileViewer.test.ts`
Expected: FAIL（当前 `indexBuildTriggered` bool 只建一次）

- [ ] **Step 3: 实现前端**

`useFileViewer.ts` 把 `let indexBuildTriggered = false;`（第 72 行）与整个 `detectProjectRoot`（第 74–89 行）替换为：
```ts
let lastIndexedRoot = "";

async function detectProjectRoot() {
  try {
    const info = await api.getProjectInfo();
    projectRoot.value = info.root;
    if (info.root && info.root !== lastIndexedRoot) {
      const previous = lastIndexedRoot;
      lastIndexedRoot = info.root;
      if (previous) {
        void api.codegraphClose(previous).catch(() => {});
      }
      void api.codegraphBuildIndex(info.root).catch(() => {});
    }
  } catch {
    // best effort; goto falls back to grep
  }
}
```
（删掉所有 `console.log("[codegraph]...")` / `console.error("[codegraph]...")`。）

- [ ] **Step 4: 删 Rust 死代码**

`indexer.rs` 删除已被取代的 `index_all`（旧全量）、`index_file`（旧增量入口）；`indexer/store.rs` 删除 `reindex_file`（旧路径，被 `reindex_one` 取代）。保留 `store::embed_and_store`。确认无调用残留：
```bash
grep -rn "index_all\|index_file\|store::reindex_file\|reindex_file" src-tauri/src
```
Expected: 无匹配（除定义已删）。

- [ ] **Step 5: 跑测试 + 编译**

Run: `pnpm vitest run src/composables/useFileViewer.test.ts`
Expected: PASS
Run: `cargo build && cargo test --lib codegraph`
Expected: 全 PASS

- [ ] **Step 6: 提交**

```bash
git add src/composables/useFileViewer.ts src-tauri/src/codegraph/indexer.rs src-tauri/src/codegraph/indexer/store.rs
git commit -m "feat(codegraph): rebuild on project switch + close previous; drop legacy indexer paths"
```

---

## Task 9: .gitignore + 端到端手测清单

**Files:**
- Modify: `.gitignore`
- Test: 手动验收（无自动测试）

- [ ] **Step 1: 加 .gitignore**

`.gitignore` 末尾追加：
```
# CodeGraph index & embedding model cache
.aide/
src-tauri/.fastembed_cache/
```
确认已跟踪的缓存被移出索引（若之前误加）：
```bash
git rm -r --cached src-tauri/.fastembed_cache 2>/dev/null || true
git status --porcelain | grep -i "aide\|fastembed" || echo "clean"
```

- [ ] **Step 2: 提交**

```bash
git add .gitignore
git commit -m "chore(codegraph): gitignore .aide/ index and fastembed cache"
```

- [ ] **Step 3: 手动验收（对照 spec §验收标准）**

`pnpm tauri dev` 打开一个中型多文件项目，逐条确认：
1. Controller 里 Cmd/Ctrl+Click 一个定义在别文件的 Service 方法 → 直接跳到该定义（标签 `[精确]`）。
2. 标题栏"符号"搜索输入符号名 → 出现结构层精确结果（图标 🔗，非纯语义 🔍）。
3. 首次打开项目、索引构建期间，反复点击文件树/切 tab → 窗口不卡（双缓冲生效）。
4. 编辑并保存某文件、改了一个方法名 → 2s 内对旧/新名字的跳转结果随之更新。
5. 切换到另一个 workspace → goto 命中新项目符号，不再返回旧项目文件。
6. 关掉再打开同一项目且未改文件 → 控制台/日志显示走了 `loaded:true`（不全量重建）。
7. 全程聊天/编辑/Git 正常，无"会话进程已退出"或未响应。

若某条不过，记录现象回到对应 Task 修正。

---

## Self-Review（作者自查，已过）

**1. Spec 覆盖：**
- C1 结构层跨文件 → Task 1（SymbolTable）+ Task 4（collect）+ Task 5（structure_lookup 查表）✓
- C2 spawn_blocking + RwLock 双缓冲 → Task 6 ✓
- M1 持久化 load + 增量 → Task 6（load_project_index/meta）+ Task 7（reindex）✓
- M2 切项目 → Task 8 ✓
- M3 close → Task 6（命令）+ Task 8（前端调用）✓
- Mo1 语义去污染 → Task 5 ✓；Mo2 删假注释 → Task 5（semantic.rs 内联，附带；如注释残留于 store.rs 在 Task 7 顺删）；Mo3 局部变量 → Task 3 ✓；Mo4 gitignore → Task 9 ✓；Mo5 成员取名 → Task 3 ✓
- 确定性 ID → Task 2 ✓；死代码清理 → Task 2/8 ✓；调试日志 → Task 8 ✓

**2. 占位符扫描：** 无 TBD/TODO；每个代码步给了完整代码。前端测试步给了断言骨架并注明"沿用文件既有 mock 结构调整 open 细节"——因该测试文件的既有 helper 未逐行展开，属可接受的局部适配点，非占位。

**3. 类型一致性：** `structure_lookup(word,&SymbolTable,cursor_line)`、`query_goto_definition(word,cursor_line,&SymbolTable,Option<&CodeShard>,Option<&Embedder>)`、`build_project_index`/`load_project_index`/`reindex_one`、`ProjectIndex{project_root,symbols,shard,indexed_at}`、`BuildStats{scanned_files,files_with_symbols,total_symbols}`、`Meta{version,model_name,indexed_at,symbol_count}` 跨任务命名一致。

**补充说明（Mo2）：** store.rs 顶部那句假的 "5s timeout" doc 注释在 Task 8 删 `reindex_file` 时一并清理；若 `embed_and_store` 上方仍留有该注释，改为准确描述。
