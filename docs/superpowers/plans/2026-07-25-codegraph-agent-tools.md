# CodeGraph Agent Tools 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 aide 内置 CodeGraph 索引暴露为 AI agent 可调用的三个 MCP 工具（find_symbol / semantic_search / call_graph），并用 A/B 实测验收工具调用数与 token 下降。

**Architecture:** sidecar 内进程 SDK MCP server（`createSdkMcpServer`）注册三工具；工具调用经 stdout 事件 `codegraph_query` 发到 Rust，Rust reader 拦截后在 `CodeGraphState` 上执行查询，经 stdin 命令 `codegraph_result` 回传，sidecar 结算挂起的 Promise 并格式化为紧凑文本。调用边（extract 已提取但丢弃）升级为一等存储 `EdgeTable`，并修复 `CallEdge.caller` 从未填充的缺口。

**Tech Stack:** Rust（Tauri v2、tree-sitter、Qdrant Edge）、TypeScript（agent-sidecar、@anthropic-ai/claude-agent-sdk 0.3.197、zod ^4、vitest）。

**Spec:** `docs/superpowers/specs/2026-07-25-codegraph-agent-tools-design.md`（验收线、错误处理矩阵、协议语义以此为准）。

## Global Constraints

- **stdout 事件必须过 DeltaCoalescer**：sidecar 里发 `codegraph_query` 走 worker 的 `emit`（→ coalescer.push），禁止直写 `process.stdout`。
- **IPC 协议 provider-agnostic**：`codegraph_query`/`codegraph_result` 字段只含符号名/路径/查询串/方向，不得出现 Claude 专属概念。
- **被 Rust 拦截的事件不进前端类型**：`codegraph_query` 只加进 sidecar `types.ts`；前端 `src/types/chat.ts` 不动（先例：`image_input_probe_result`/`heartbeat` 不在前端类型里）。
- **Rust 重活一律 `spawn_blocking`**；`State` 跨线程用 `Arc<T>`（`CodeGraphState` 已在 `lib.rs:101` 按 Arc 注册）。
- **Rust 测试用 `cargo test --lib`**（避开杀软锁全量 target）；在 `src-tauri/` 目录下跑。
- **sidecar 测试用 `npx vitest run <file>`**；在 `agent-sidecar/` 目录下跑（vitest 已在 node_modules/.bin）。
- **sidecar 包管理用 npm**（agent-sidecar/ 下有 package-lock.json，不用 pnpm）。
- **输出 token 纪律是硬约束**：find_symbol ≤20 条、semantic 默认 5/上限 10 条且 snippet ≤300 字符、call_graph 单方向 ≤30 条；单次工具结果目标 ≤2KB。
- 任何工具失败路径**返回文本而非抛错**（超时/取消/索引缺失都是文本提示 agent 退回 Grep）。
- dev 改 sidecar 后必须重启 `pnpm tauri dev` 才生效（A/B 实测时牢记）。

---

### Task 1: EdgeTable —— 调用边的一等存储

**Files:**
- Create: `src-tauri/src/codegraph/edges.rs`
- Modify: `src-tauri/src/codegraph/mod.rs`（`pub mod edges;` 加进模块列表，约 line 1-9 区域）

**Interfaces:**
- Consumes: `crate::codegraph::types::CallEdge { caller: String, callee: String, file: String, line: usize }`（已存在）
- Produces: `pub struct EdgeTable`，方法签名：
  - `EdgeTable::new() -> Self`
  - `insert(&mut self, edge: CallEdge)`（双索引各存一份）
  - `callers_of(&self, name: &str) -> Vec<CallEdge>`（callee == name 的边）
  - `callees_of(&self, name: &str) -> Vec<CallEdge>`（caller == name 的边）
  - `remove_file(&mut self, file: &str)`
  - `len(&self) -> usize`
  - `save_json(&self, path: &Path) -> std::io::Result<()>` / `load_json(path: &Path) -> Option<Self>`

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/codegraph/edges.rs`，先只放测试（实现稍后）：

```rust
use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::codegraph::types::CallEdge;

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(caller: &str, callee: &str, file: &str, line: usize) -> CallEdge {
        CallEdge { caller: caller.into(), callee: callee.into(), file: file.into(), line }
    }

    #[test]
    fn dual_index_lookup_both_directions() {
        let mut t = EdgeTable::new();
        t.insert(edge("main", "save", "a.ts", 10));
        t.insert(edge("main", "load", "a.ts", 11));
        t.insert(edge("boot", "save", "b.ts", 5));
        assert_eq!(t.callers_of("save").len(), 2);
        assert_eq!(t.callees_of("main").len(), 2);
        assert_eq!(t.callers_of("missing").len(), 0);
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn remove_file_drops_edges_from_both_indexes() {
        let mut t = EdgeTable::new();
        t.insert(edge("main", "save", "a.ts", 10));
        t.insert(edge("boot", "save", "b.ts", 5));
        t.remove_file("a.ts");
        assert_eq!(t.callers_of("save").len(), 1);
        assert_eq!(t.callees_of("main").len(), 0);
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn json_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cg_edges_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("edges.json");
        let mut t = EdgeTable::new();
        t.insert(edge("main", "save", "a.ts", 10));
        t.save_json(&path).unwrap();
        let loaded = EdgeTable::load_json(&path).unwrap();
        assert_eq!(loaded.callers_of("save").len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: 确认编译失败**

Run: `cd src-tauri && cargo test --lib codegraph::edges`
Expected: FAIL（`EdgeTable` 未定义）

- [ ] **Step 3: 实现 EdgeTable**

在 `src-tauri/src/codegraph/edges.rs` 顶部（`mod tests` 之前）加：

```rust
/// In-memory call-edge index, dual-keyed: `by_callee` answers "who calls X",
/// `by_caller` answers "what does X call". Structure-layer ground truth from
/// tree-sitter extraction; name-level joins (ambiguity handled in query::calls).
#[derive(Default, Serialize, Deserialize)]
pub struct EdgeTable {
    by_callee: HashMap<String, Vec<CallEdge>>,
    by_caller: HashMap<String, Vec<CallEdge>>,
}

impl EdgeTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, edge: CallEdge) {
        self.by_caller
            .entry(edge.caller.clone())
            .or_default()
            .push(edge.clone());
        self.by_callee.entry(edge.callee.clone()).or_default().push(edge);
    }

    /// All edges whose callee is `name` (call sites of `name`).
    pub fn callers_of(&self, name: &str) -> Vec<CallEdge> {
        self.by_callee.get(name).cloned().unwrap_or_default()
    }

    /// All edges whose caller is `name` (calls made by `name`).
    pub fn callees_of(&self, name: &str) -> Vec<CallEdge> {
        self.by_caller.get(name).cloned().unwrap_or_default()
    }

    /// Drop every edge recorded in `file` (incremental re-index).
    pub fn remove_file(&mut self, file: &str) {
        for v in self.by_callee.values_mut().chain(self.by_caller.values_mut()) {
            v.retain(|e| e.file != file);
        }
        self.by_callee.retain(|_, v| !v.is_empty());
        self.by_caller.retain(|_, v| !v.is_empty());
    }

    pub fn len(&self) -> usize {
        self.by_callee.values().map(|v| v.len()).sum()
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

在 `src-tauri/src/codegraph/mod.rs` 模块列表加一行 `pub mod edges;`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib codegraph::edges`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codegraph/edges.rs src-tauri/src/codegraph/mod.rs
git commit -m "feat(codegraph): EdgeTable 双索引调用边存储（by_caller/by_callee + 持久化）"
```

---

### Task 2: 修复 extract——为 CallEdge 填充 caller

现状缺口：`extract.rs` 调用节点分支把 `caller` 推为 `String::new()`，全库无任何代码填它。修复方式：递归穿一个 `current_fn: Option<&str>` 上下文（与 `parent_sym` 同款模式），进入函数/方法定义节点时更新，生成边时填入。

**Files:**
- Modify: `src-tauri/src/codegraph/indexer/extract.rs`

**Interfaces:**
- Consumes: 无新增。
- Produces: `extract_from_node` 新签名（私有函数）：
  `fn extract_from_node(node: &Node, source: &str, file: &str, parent_sym: Option<&str>, current_fn: Option<&str>, symbols: &mut Vec<IndexedPoint>, call_edges: &mut Vec<CallEdge>)`
  生成的 `CallEdge.caller` = 所属函数/方法名；模块顶层调用 = `""`。

- [ ] **Step 1: 写失败测试**

在 `extract.rs` 的 `#[cfg(test)] mod tests` 里追加（现有 `python_calls_produce_edges` 旁）：

```rust
#[test]
fn call_edges_carry_enclosing_function_as_caller() {
    let pm = ParserManager::new();
    let src = "function outer() { inner(); }\nfunction inner() {}\n";
    let (_points, edges) = extract_symbols(Path::new("a.ts"), src, &pm, Path::new("."));
    let e = edges.iter().find(|e| e.callee == "inner").expect("edge for inner()");
    assert_eq!(e.caller, "outer", "call inside outer() must record caller");
}

#[test]
fn method_body_call_edges_carry_method_name() {
    let pm = ParserManager::new();
    let src = "class A { void m() { helper(); } void helper() {} }";
    let (_points, edges) = extract_symbols(Path::new("A.java"), src, &pm, Path::new("."));
    let e = edges.iter().find(|e| e.callee == "helper").expect("edge for helper()");
    assert_eq!(e.caller, "m");
}

#[test]
fn top_level_call_has_empty_caller() {
    let pm = ParserManager::new();
    let src = "doThing();\n";
    let (_points, edges) = extract_symbols(Path::new("a.ts"), src, &pm, Path::new("."));
    let e = edges.iter().find(|e| e.callee == "doThing").expect("edge for doThing()");
    assert_eq!(e.caller, "", "module-level call has no enclosing function");
}
```

- [ ] **Step 2: 确认失败**

Run: `cd src-tauri && cargo test --lib codegraph::indexer::extract`
Expected: 新 3 个测试 FAIL（caller 全是 `""`）

- [ ] **Step 3: 实现**

3a. `extract_from_node` 签名加参数（`parent_sym` 之后）：

```rust
fn extract_from_node(
    node: &Node,
    source: &str,
    file: &str,
    parent_sym: Option<&str>,
    current_fn: Option<&str>,   // 所属函数/方法名，用于填 CallEdge.caller
    symbols: &mut Vec<IndexedPoint>,
    call_edges: &mut Vec<CallEdge>,
) {
```

3b. 所有递归调用点机械更新（除 3d 外全部原样透传 `current_fn`）：
- `extract_symbols` 顶层调用（约 line 38-48）：加实参 `None`；
- class 分支（约 line 86）、struct 分支（~164）、enum 分支（~197）、trait 分支（~231）、impl 分支（~254）：递归调用加 `current_fn` 透传；
- 文件底部通用递归（~line 427-431）：`extract_from_node(&child, source, file, parent_sym, current_fn, symbols, call_edges)`；
- `extract_vue_sfc` 的调用点（~line 512）：加实参 `None`。

3c. 调用节点分支填 caller（约 line 414）：

```rust
call_edges.push(CallEdge {
    caller: current_fn.unwrap_or("").to_string(),
    callee: callee.to_string(),
    file: file.to_string(),
    line: start.row + 1,
});
```

3d. 函数/方法定义分支（`"method_declaration" | "function_declaration" | ...` 约 line 267-296）：push 符号后**改为自带递归并 return**（原先是落到文件底部通用递归），用函数名更新 `current_fn`：

```rust
"method_declaration" | "function_declaration"
| "method_definition" | "function_definition"
| "function_item" | "constructor_declaration"
// Rust trait method declarations (no body)
| "function_signature_item" => {
    if let Some(name_node) = node.child_by_field_name("name") {
        let name = match name_node.utf8_text(source.as_bytes()) {
            Ok(n) => n,
            Err(_) => return,
        };
        let start = node.start_position();
        let kind = if parent_sym.is_some() || kind.contains("method") {
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
                parent: parent_sym.map(|s| s.to_string()),
            },
            source: Confidence::Structure,
            code_snippet: symbol_snippet(&name, "fn", node, source),
        });
        // Recurse into the body with this function as the enclosing caller,
        // so call edges inside it record `caller = name`. Nested function
        // definitions re-shadow current_fn when entered.
        let fn_name = name.to_string();
        for i in 0..node.child_count() {
            if let Some(child) = node.child(i) {
                extract_from_node(
                    &child, source, file, parent_sym, Some(&fn_name),
                    symbols, call_edges,
                );
            }
        }
        return; // children already handled
    }
}
```

注意：同名 `let kind` 遮蔽了外层 `node.kind()` 的绑定是现有代码行为，保留不动。

- [ ] **Step 4: 跑测试**

Run: `cd src-tauri && cargo test --lib codegraph::indexer::extract`
Expected: 全部 PASS（含既有测试——顶层调用 caller 仍为空字符串，不破坏旧断言）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codegraph/indexer/extract.rs
git commit -m "fix(codegraph): extract 填充 CallEdge.caller（穿透所属函数上下文）"
```

---

### Task 3: 接线——EdgeTable 进 build/reindex/load 全链路 + ProjectIndex 携带

**Files:**
- Modify: `src-tauri/src/codegraph/indexer.rs`（collect_symbols / build_structure_index / load_project_index / load_compatible_index / reindex_one）
- Modify: `src-tauri/src/codegraph/mod.rs`（ProjectIndex 加 `edges` 字段 + 各构造点）

**Interfaces:**
- Consumes: Task 1 的 `EdgeTable`；Task 2 的有 caller 的边。
- Produces（后续任务依赖的签名）：
  - `collect_symbols(...) -> (SymbolTable, EdgeTable, Vec<IndexedPoint>, BuildStats)`
  - `build_structure_index(...) -> Result<(SymbolTable, EdgeTable, Arc<CodeShard>, Vec<IndexedPoint>, BuildStats), _>`
  - `load_project_index(...) -> Option<(SymbolTable, EdgeTable, Arc<CodeShard>)>`
  - `load_compatible_index(...) -> Option<(SymbolTable, EdgeTable, Arc<CodeShard>, Meta)>`
  - `reindex_one(project_root, abs_file, table: &mut SymbolTable, edges: &mut EdgeTable, shard, embedder, model_name, dim, parser_manager)`
  - `ProjectIndex { project_root, symbols, edges: EdgeTable, shard, indexed_at, embed_ready }`

- [ ] **Step 1: 改测试先行——更新 indexer.rs 既有测试 + 新增边表断言**

`indexer.rs` 测试区：
- `collect_builds_cross_file_table`：`let (table, points, stats) = ...` 改为 `let (table, edges, points, stats) = ...`，追加断言 `assert!(edges.len() > 0 || points.len() > 0)` 占位不对——改成精确断言：该 fixture 两个类各有一个 `save()` 方法体为空，无边；把 fixture 改为含调用：

```rust
#[test]
fn collect_builds_cross_file_table() {
    let dir = std::env::temp_dir().join(format!("cg_collect_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("UserService.java"),
        "class UserService { void save() { persist(); } void persist() {} }").unwrap();
    std::fs::write(dir.join("OrderService.java"),
        "class OrderService { void save() {} }").unwrap();

    let pm = ParserManager::new();
    let (table, edges, points, stats) = collect_symbols(&dir, &pm, None);

    assert_eq!(table.lookup("save").len(), 2);
    assert!(table.lookup("UserService").len() == 1);
    assert!(stats.files_with_symbols == 2);
    assert!(!points.is_empty());
    // 调用边随符号一起收集：persist 在 save 内被调用
    let e = edges.callers_of("persist");
    assert_eq!(e.len(), 1);
    assert_eq!(e[0].caller, "save");
    std::fs::remove_dir_all(&dir).ok();
}
```

- 其余解构 `build_structure_index` 返回值的测试（`load_compatible_index_loads_stale_index_ignoring_staleness` 里 `let (_table, shard, _points, _stats)`、`load_compatible_index_none_when_embed_incomplete` 里 `let (_t, shard, _p, _s)`）：各加一个 `_edges` 占位段。`load_compatible_index` 解构处同样加 edges：`let (t, _e, _s, meta) = loaded.unwrap();`。
- 新增持久化测试：

```rust
#[test]
fn build_persists_edges_json_and_loaders_require_it() {
    let dir = std::env::temp_dir().join(format!("cg_edges_persist_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.ts"),
        "function caller() { target(); }\nfunction target() {}\n").unwrap();
    let pm = ParserManager::new();
    {
        let (_t, edges, shard, _p, _s) =
            super::build_structure_index(&dir, &pm, 4, "test-model", None).unwrap();
        assert_eq!(edges.callers_of("target").len(), 1);
        drop(shard);
    }
    let base = super::index_dir(&dir);
    assert!(base.join("edges.json").exists(), "build must persist edges.json");
    // embed 标记完成后 loader 必须连边一起载回
    {
        let mut m = crate::codegraph::meta::Meta::load(&base.join("meta.json")).unwrap();
        m.embed_complete = true;
        m.save(&base.join("meta.json")).unwrap();
    }
    let (_t, edges, _s, _meta) =
        super::load_compatible_index(&dir, "test-model", 4).expect("compatible index loads");
    assert_eq!(edges.callers_of("target").len(), 1, "edges survive persist+load");
    // edges.json 缺失 → 视为不兼容（旧索引），强制全量重建
    std::fs::remove_file(base.join("edges.json")).unwrap();
    assert!(super::load_compatible_index(&dir, "test-model", 4).is_none(),
        "missing edges.json must force rebuild");
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: 确认编译失败**

Run: `cd src-tauri && cargo test --lib codegraph::indexer`
Expected: FAIL（`collect_symbols` 返回值段数不匹配等编译错误）

- [ ] **Step 3: 实现**

3a. `indexer.rs` 顶部 import 加 `use crate::codegraph::edges::EdgeTable;`。

3b. `collect_symbols`：返回加 `EdgeTable`；注意**边插入要在 `points.is_empty()` continue 之前**（纯调用无符号的文件也要留边）：

```rust
pub fn collect_symbols(
    project_root: &Path,
    parser_manager: &ParserManager,
    on_status: Option<&dyn Fn(&str)>,
) -> (SymbolTable, EdgeTable, Vec<IndexedPoint>, BuildStats) {
    let exts = parser_manager.supported_extensions();
    let ext_refs: Vec<&str> = exts.iter().copied().collect();
    if let Some(f) = on_status {
        f("扫描文件树...");
    }
    let files = walk::walk_source_files(project_root, &ext_refs);
    let total_files = files.len();

    let mut table = SymbolTable::new();
    let mut edges = EdgeTable::new();
    let mut all_points: Vec<IndexedPoint> = Vec::new();
    let mut stats = BuildStats::default();

    for (i, file_path) in files.iter().enumerate() {
        stats.scanned_files += 1;
        if let Some(f) = on_status {
            f(&format!("解析 {} ({}/{})", file_path.display(), i + 1, total_files));
        }
        let source = match std::fs::read_to_string(file_path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("codegraph: read failed {}: {}", file_path.display(), e);
                continue;
            }
        };
        let (points, file_edges) =
            extract_symbols(file_path, &source, parser_manager, project_root);
        for e in file_edges {
            edges.insert(e);
        }
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
    (table, edges, all_points, stats)
}
```

3c. `build_structure_index`：返回类型加 `EdgeTable`；`let (table, edges, points, stats) = collect_symbols(...)`；persist 段在 `symbols.json` 之后加：

```rust
if let Err(e) = edges.save_json(&base.join("edges.json")) {
    tracing::warn!("codegraph: edges.json persist failed: {}", e);
}
```

返回 `Ok((table, edges, Arc::new(shard), points, stats))`。

3d. `load_project_index` / `load_compatible_index`：在 `SymbolTable::load_json` 之后各加一行 `let edges = EdgeTable::load_json(&base.join("edges.json"))?;`（缺失 → None → 走全量重建），返回值插入 `edges`。

3e. `reindex_one`：签名在 `table: &mut SymbolTable` 后加 `edges: &mut EdgeTable`；`table.remove_file(&rel)` 之后加 `edges.remove_file(&rel);`；`extract` 后插入新边：

```rust
let (points, file_edges) = extract::extract_symbols(abs_file, &source, parser_manager, project_root);
for e in file_edges {
    edges.insert(e);
}
```

persist 段 `symbols.json` 之后加：

```rust
if let Err(e) = edges.save_json(&base.join("edges.json")) {
    tracing::warn!("codegraph: edges.json re-persist failed: {}", e);
}
```

3f. `mod.rs`：`ProjectIndex` 加字段 `pub edges: EdgeTable`；所有构造点补字段——
- 快速路径（`load_project_index` 解出处，约 line 309-320）：`let Some((table, edges, shard)) = ...`，构造加 `edges`；
- Phase 1 swap（约 line 377）：`build_structure_index` 解出 `edges`，构造加 `edges`；
- `try_incremental_build`（约 line 900-928）：`load_compatible_index` 解出 `edges`，构造加 `edges`；
- `reindex_one` 三处调用点（`codegraph_reindex_file`、`codegraph_rescan`、`try_incremental_build`）：实参加 `&mut pi.edges`；
- `mod.rs` 测试里两个 `ProjectIndex` 字面量（约 line 1087、1101）：加 `edges: crate::codegraph::edges::EdgeTable::new()`。

- [ ] **Step 4: 跑测试**

Run: `cd src-tauri && cargo test --lib codegraph`
Expected: 全部 PASS（含 mod.rs 两个回归测试）

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codegraph/indexer.rs src-tauri/src/codegraph/mod.rs
git commit -m "feat(codegraph): EdgeTable 接入 build/reindex/load 全链路，edges.json 持久化"
```

---

### Task 4: query/calls.rs —— 调用图查询

**Files:**
- Create: `src-tauri/src/codegraph/query/calls.rs`
- Modify: `src-tauri/src/codegraph/query.rs`（加 `pub mod calls;`）

**Interfaces:**
- Consumes: `EdgeTable::{callers_of, callees_of}`、`SymbolTable::lookup_ignore_case`。
- Produces：
  - `pub const CALL_GRAPH_CAP: usize = 30;`
  - `pub struct CallSite { peer: String, peer_defs: Vec<String>, call_file: String, call_line: usize }`（`Serialize`）
  - `pub struct CallGraphResult { sites: Vec<CallSite>, candidates: usize, truncated: bool }`（`Serialize`）
  - `pub fn callers(name: &str, edges: &EdgeTable, table: &SymbolTable) -> CallGraphResult`
  - `pub fn callees(name: &str, edges: &EdgeTable, table: &SymbolTable) -> CallGraphResult`

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/codegraph/query/calls.rs`：

```rust
use serde::Serialize;

use crate::codegraph::edges::EdgeTable;
use crate::codegraph::symbols::SymbolTable;
use crate::codegraph::types::CallEdge;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::types::{SymbolDef, SymbolKind};

    fn sym(name: &str, file: &str, line: usize) -> SymbolDef {
        SymbolDef { name: name.into(), kind: SymbolKind::Method, file: file.into(), line, column: 1, parent: None }
    }

    fn fixture() -> (EdgeTable, SymbolTable) {
        let mut edges = EdgeTable::new();
        edges.insert(CallEdge { caller: "main".into(), callee: "save".into(), file: "b.ts".into(), line: 88 });
        edges.insert(CallEdge { caller: "".into(), callee: "save".into(), file: "c.ts".into(), line: 3 });
        edges.insert(CallEdge { caller: "main".into(), callee: "load".into(), file: "b.ts".into(), line: 90 });
        let mut table = SymbolTable::new();
        table.insert(sym("main", "b.ts", 10));
        table.insert(sym("save", "a.ts", 42));
        table.insert(sym("load", "d.ts", 7));
        (edges, table)
    }

    #[test]
    fn callers_returns_sites_with_peer_definitions() {
        let (edges, table) = fixture();
        let r = callers("save", &edges, &table);
        assert_eq!(r.sites.len(), 2);
        assert_eq!(r.candidates, 1, "save has exactly one definition");
        let site = r.sites.iter().find(|s| s.peer == "main").unwrap();
        assert_eq!(site.peer_defs, vec!["b.ts:10".to_string()]);
        assert_eq!(site.call_file, "b.ts");
        assert_eq!(site.call_line, 88);
        // 顶层调用 peer 标注
        assert!(r.sites.iter().any(|s| s.peer == "(顶层)"));
    }

    #[test]
    fn callees_returns_what_function_calls() {
        let (edges, table) = fixture();
        let r = callees("main", &edges, &table);
        assert_eq!(r.sites.len(), 2);
        let callees: Vec<&str> = r.sites.iter().map(|s| s.peer.as_str()).collect();
        assert!(callees.contains(&"save"));
        assert!(callees.contains(&"load"));
    }

    #[test]
    fn ambiguous_name_reports_candidate_count() {
        let (edges, mut table) = fixture();
        table.insert(sym("save", "z.ts", 1)); // 第二个 save 定义
        let r = callers("save", &edges, &table);
        assert_eq!(r.candidates, 2, "two save definitions → candidates=2");
    }

    #[test]
    fn cap_truncates_and_flags() {
        let mut edges = EdgeTable::new();
        for i in 0..35 {
            edges.insert(CallEdge { caller: format!("f{}", i), callee: "hot".into(), file: "x.ts".into(), line: i });
        }
        let table = SymbolTable::new();
        let r = callers("hot", &edges, &table);
        assert_eq!(r.sites.len(), CALL_GRAPH_CAP);
        assert!(r.truncated);
    }
}
```

- [ ] **Step 2: 确认编译失败**

Run: `cd src-tauri && cargo test --lib codegraph::query::calls`
Expected: FAIL（`callers`/`callees`/`CALL_GRAPH_CAP` 未定义；若报模块不存在，先在 `query.rs` 加 `pub mod calls;`）

- [ ] **Step 3: 实现**

在 `calls.rs` 顶部（`mod tests` 之前）加：

```rust
/// Cap per direction per query — token discipline for agent-facing output.
pub const CALL_GRAPH_CAP: usize = 30;

/// One call-graph result row: the symbol on the other end of the edge, its
/// candidate definition locations (name-level join can be ambiguous), and the
/// call site. All strings are pre-formatted for compact agent consumption.
#[derive(Debug, Clone, Serialize)]
pub struct CallSite {
    /// Name of the symbol on the other end; "(顶层)" for module-scope calls.
    pub peer: String,
    /// "file:line" of every definition of `peer` (empty for top-level peers).
    pub peer_defs: Vec<String>,
    pub call_file: String,
    pub call_line: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CallGraphResult {
    pub sites: Vec<CallSite>,
    /// Number of distinct definitions the QUERIED name maps to (>1 = the
    /// name-level join is ambiguous; agent should Read to disambiguate).
    pub candidates: usize,
    pub truncated: bool,
}

fn to_sites(edges: Vec<CallEdge>, peer_of: fn(&CallEdge) -> &str, table: &SymbolTable) -> (Vec<CallSite>, bool) {
    let truncated = edges.len() > CALL_GRAPH_CAP;
    let sites = edges
        .into_iter()
        .take(CALL_GRAPH_CAP)
        .map(|e| {
            let raw = peer_of(&e);
            let (peer, peer_defs) = if raw.is_empty() {
                ("(顶层)".to_string(), Vec::new())
            } else {
                (
                    raw.to_string(),
                    table
                        .lookup_ignore_case(raw)
                        .iter()
                        .map(|d| format!("{}:{}", d.file, d.line))
                        .collect(),
                )
            };
            CallSite { peer, peer_defs, call_file: e.file, call_line: e.line }
        })
        .collect();
    (sites, truncated)
}

/// Who calls `name` — edges whose callee is `name`, peer = caller.
pub fn callers(name: &str, edges: &EdgeTable, table: &SymbolTable) -> CallGraphResult {
    let candidates = table.lookup_ignore_case(name).len();
    let (sites, truncated) = to_sites(edges.callers_of(name), |e| e.caller.as_str(), table);
    CallGraphResult { sites, candidates, truncated }
}

/// What `name` calls — edges whose caller is `name`, peer = callee.
pub fn callees(name: &str, edges: &EdgeTable, table: &SymbolTable) -> CallGraphResult {
    let candidates = table.lookup_ignore_case(name).len();
    let (sites, truncated) = to_sites(edges.callees_of(name), |e| e.callee.as_str(), table);
    CallGraphResult { sites, candidates, truncated }
}
```

- [ ] **Step 4: 跑测试**

Run: `cd src-tauri && cargo test --lib codegraph::query::calls`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codegraph/query/calls.rs src-tauri/src/codegraph/query.rs
git commit -m "feat(codegraph): callers/callees 调用图查询（候选标注 + 30 条上限）"
```

---

### Task 5: codegraph/agent.rs —— agent 查询执行层

**Files:**
- Create: `src-tauri/src/codegraph/agent.rs`
- Modify: `src-tauri/src/codegraph/mod.rs`（加 `pub mod agent;`）

**Interfaces:**
- Consumes: `CodeGraphState`（`inner`/`embedder` 是 codegraph 模块私有字段，agent 作为其子模块可直接访问）、`query::structure::structure_lookup`、`query::semantic::semantic_search`、`query::calls::{callers, callees}`。
- Produces：
  - `pub const FIND_SYMBOL_CAP: usize = 20;`
  - `pub const SEMANTIC_DEFAULT_LIMIT: usize = 5;`
  - `pub const SEMANTIC_MAX_LIMIT: usize = 10;`
  - `pub const SNIPPET_CAP: usize = 300;`
  - `pub struct AgentQueryRequest { request_id: String, tool: String, args: Value, project_root: String }`
  - `pub fn parse_codegraph_query(event: &Value) -> Option<AgentQueryRequest>`
  - `pub fn execute_agent_query(st: &CodeGraphState, tool: &str, args: &Value, project_root: &str) -> Value`
  返回 payload 形状：`{"ok": bool, "status": "ready"|"structure_only"|"no_index"|"wrong_project"|"error", "results": [...], "candidates"?: usize, "truncated"?: bool, "error"?: String}`（`request_id`/`cmd` 由调用方补）。

- [ ] **Step 1: 写失败测试**

创建 `src-tauri/src/codegraph/agent.rs`：

```rust
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use super::CodeGraphState;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codegraph::edges::EdgeTable;
    use crate::codegraph::symbols::SymbolTable;
    use crate::codegraph::types::{CallEdge, SymbolDef, SymbolKind};
    use std::sync::atomic::{AtomicBool, Ordering as AOrdering};
    use std::sync::Arc;

    fn sym(name: &str, kind: SymbolKind, file: &str, line: usize) -> SymbolDef {
        SymbolDef { name: name.into(), kind, file: file.into(), line, column: 1, parent: None }
    }

    /// 造一个只含结构层（embed_ready=false）的活跃索引。
    fn state_with_index(root: &str) -> (CodeGraphState, PathBuf) {
        let dir = std::env::temp_dir().join(format!("cg_agent_{}_{}", root, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let shard = crate::codegraph::shard::CodeShard::create(&dir, 4).unwrap();
        let mut table = SymbolTable::new();
        table.insert(sym("save", SymbolKind::Method, "a.ts", 42));
        let mut edges = EdgeTable::new();
        edges.insert(CallEdge { caller: "main".into(), callee: "save".into(), file: "b.ts".into(), line: 88 });
        let st = CodeGraphState::new();
        *st.inner.write().unwrap() = Some(crate::codegraph::ProjectIndex {
            project_root: PathBuf::from(root),
            symbols: table,
            edges,
            shard: Arc::new(shard),
            indexed_at: std::time::SystemTime::now(),
            embed_ready: Arc::new(AtomicBool::new(false)),
        });
        (st, dir)
    }

    #[test]
    fn parse_requires_request_id() {
        assert!(parse_codegraph_query(&json!({"type":"codegraph_query","tool":"find_symbol","args":{},"project_root":"/x"})).is_none());
        let r = parse_codegraph_query(&json!({"type":"codegraph_query","request_id":"r1","tool":"find_symbol","args":{"name":"x"},"project_root":"/x"})).unwrap();
        assert_eq!(r.request_id, "r1");
        assert_eq!(r.tool, "find_symbol");
        assert!(parse_codegraph_query(&json!({"type":"text_delta"})).is_none());
    }

    #[test]
    fn no_index_and_wrong_project_statuses() {
        let st = CodeGraphState::new();
        let r = execute_agent_query(&st, "find_symbol", &json!({"name":"save"}), "/proj");
        assert_eq!(r["status"], "no_index");

        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "find_symbol", &json!({"name":"save"}), "projB");
        assert_eq!(r["status"], "wrong_project");
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_symbol_ready_with_results() {
        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "find_symbol", &json!({"name":"save"}), "projA");
        assert_eq!(r["status"], "ready");
        let results = r["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["file"], "a.ts");
        assert_eq!(results[0]["line"], 42);
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_symbol_zero_hits_stays_ready() {
        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "find_symbol", &json!({"name":"nope"}), "projA");
        assert_eq!(r["status"], "ready", "zero hits ≠ index unavailable");
        assert_eq!(r["results"].as_array().unwrap().len(), 0);
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn call_graph_callers_direction() {
        let (st, dir) = state_with_index("projA");
        let r = execute_agent_query(&st, "call_graph", &json!({"name":"save","direction":"callers"}), "projA");
        assert_eq!(r["status"], "ready");
        let results = r["results"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["peer"], "main");
        assert_eq!(results[0]["call_file"], "b.ts");
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn semantic_blocked_until_embed_ready() {
        let (st, dir) = state_with_index("projA"); // embed_ready=false
        let r = execute_agent_query(&st, "semantic_search", &json!({"query":"auth"}), "projA");
        assert_eq!(r["status"], "structure_only");
        crate::codegraph::guard::drop_catching_panics(st.inner.write().unwrap().take(), "test");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_tool_is_error() {
        let st = CodeGraphState::new();
        let r = execute_agent_query(&st, "nonsense", &json!({}), "/x");
        assert_eq!(r["ok"], false);
        assert_eq!(r["status"], "error");
    }
}
```

- [ ] **Step 2: 确认编译失败**

Run: `cd src-tauri && cargo test --lib codegraph::agent`
Expected: FAIL（模块未注册/函数未定义；在 `mod.rs` 加 `pub mod agent;` 后报函数未定义）

- [ ] **Step 3: 实现**

`mod.rs` 加 `pub mod agent;`。`agent.rs` 顶部（`mod tests` 之前）加：

```rust
pub const FIND_SYMBOL_CAP: usize = 20;
pub const SEMANTIC_DEFAULT_LIMIT: usize = 5;
pub const SEMANTIC_MAX_LIMIT: usize = 10;
/// Semantic snippets are trimmed to this many chars — signature + body start,
/// never a whole function body (token discipline for agent-facing output).
pub const SNIPPET_CAP: usize = 300;

/// One intercepted `codegraph_query` event, validated.
pub struct AgentQueryRequest {
    pub request_id: String,
    pub tool: String,
    pub args: Value,
    pub project_root: String,
}

/// Validate + extract an agent query event. None → not a codegraph_query, or
/// malformed (missing request_id) — caller ignores it.
pub fn parse_codegraph_query(event: &Value) -> Option<AgentQueryRequest> {
    if event.get("type").and_then(|t| t.as_str()) != Some("codegraph_query") {
        return None;
    }
    Some(AgentQueryRequest {
        request_id: event.get("request_id")?.as_str()?.to_string(),
        tool: event.get("tool").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        args: event.get("args").cloned().unwrap_or(Value::Null),
        project_root: event
            .get("project_root")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn err_payload(msg: impl Into<String>) -> Value {
    json!({"ok": false, "status": "error", "error": msg.into()})
}

/// Execute one agent tool query against the live index. Designed to run inside
/// `spawn_blocking` (in-memory reads + optional shard search + optional embed).
/// Every outcome is a payload — this function never panics into the reader
/// task and never blocks on anything but the embedder mutex.
pub fn execute_agent_query(
    st: &CodeGraphState,
    tool: &str,
    args: &Value,
    project_root: &str,
) -> Value {
    let root = PathBuf::from(project_root);
    match tool {
        "find_symbol" | "call_graph" => {
            let guard = match st.inner.read() {
                Ok(g) => g,
                Err(_) => return err_payload("index lock poisoned"),
            };
            let pi = match guard.as_ref() {
                None => return json!({"ok": true, "status": "no_index", "results": []}),
                Some(pi) => pi,
            };
            if pi.project_root != root {
                return json!({"ok": true, "status": "wrong_project", "results": []});
            }
            if tool == "find_symbol" {
                let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let hits = super::query::structure::structure_lookup(name, &pi.symbols, 0);
                let results: Vec<Value> = hits
                    .into_iter()
                    .take(FIND_SYMBOL_CAP)
                    .map(|r| {
                        json!({
                            "kind": format!("{:?}", r.symbol.kind),
                            "name": r.symbol.name,
                            "file": r.symbol.file,
                            "line": r.symbol.line,
                            "parent": r.symbol.parent,
                        })
                    })
                    .collect();
                json!({"ok": true, "status": "ready", "results": results})
            } else {
                let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let direction = args.get("direction").and_then(|v| v.as_str()).unwrap_or("callers");
                let r = if direction == "callees" {
                    super::query::calls::callees(name, &pi.edges, &pi.symbols)
                } else {
                    super::query::calls::callers(name, &pi.edges, &pi.symbols)
                };
                json!({
                    "ok": true,
                    "status": "ready",
                    "results": r.sites,
                    "candidates": r.candidates,
                    "truncated": r.truncated,
                })
            }
        }
        "semantic_search" => {
            // Clone shard + read embed_ready under the read lock, then DROP it
            // before the embed (same TOCTOU-safe pattern as codegraph_goto_definition).
            let (shard, embed_ready, root_ok, has_index) = {
                let guard = match st.inner.read() {
                    Ok(g) => g,
                    Err(_) => return err_payload("index lock poisoned"),
                };
                match guard.as_ref() {
                    None => (None, false, false, false),
                    Some(pi) => (
                        Some(pi.shard.clone()),
                        pi.embed_ready.load(Ordering::Relaxed),
                        pi.project_root == root,
                        true,
                    ),
                }
            };
            if !has_index {
                return json!({"ok": true, "status": "no_index", "results": []});
            }
            if !root_ok {
                return json!({"ok": true, "status": "wrong_project", "results": []});
            }
            if !embed_ready {
                return json!({"ok": true, "status": "structure_only", "results": []});
            }
            let shard = match shard {
                Some(s) => s,
                None => return err_payload("shard missing"),
            };
            let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|n| (n as usize).clamp(1, SEMANTIC_MAX_LIMIT))
                .unwrap_or(SEMANTIC_DEFAULT_LIMIT);
            let emb = match st.embedder.lock() {
                Ok(e) => e,
                Err(_) => return err_payload("embedder lock poisoned"),
            };
            let embedder = match emb.as_ref() {
                Some(e) => e,
                None => return json!({"ok": true, "status": "structure_only", "results": []}),
            };
            match super::query::semantic::semantic_search(query, embedder.as_ref(), &shard, limit) {
                Ok(hits) => {
                    let results: Vec<Value> = hits
                        .into_iter()
                        .map(|r| {
                            let mut snippet = r.code_snippet.chars().take(SNIPPET_CAP).collect::<String>();
                            if r.code_snippet.chars().count() > SNIPPET_CAP {
                                snippet.push('…');
                            }
                            json!({
                                "name": r.symbol.name,
                                "kind": format!("{:?}", r.symbol.kind),
                                "file": r.symbol.file,
                                "line": r.symbol.line,
                                "score": r.score,
                                "snippet": snippet,
                            })
                        })
                        .collect();
                    json!({"ok": true, "status": "ready", "results": results})
                }
                Err(e) => err_payload(format!("semantic search failed: {e}")),
            }
        }
        other => err_payload(format!("unknown tool: {other}")),
    }
}
```

配套小改（已核实，必须做）：shard 的 payload 存了 `code_snippet`（`shard.rs:193`）但 `search` 没把它读进 `QueryResult`（`shard.rs:260-287`）。三处修改：
1. `types.rs` `QueryResult` 加字段 `#[serde(default)] pub snippet: Option<String>`；
2. `shard.rs` `search` 的结果构造加 `snippet: get_payload_str(&r.payload, "code_snippet"),`；
3. `query/structure.rs` 的 `QueryResult` 字面量加 `snippet: None`（约 line 18-22）。
前端 `QueryResult` 类型忽略该字段即可（serde default 向后兼容），goto 浮层不受影响。agent.rs 语义分支相应读 `r.snippet.unwrap_or_default()`。

- [ ] **Step 4: 跑测试**

Run: `cd src-tauri && cargo test --lib codegraph`
Expected: agent 7 个测试 PASS，其余全绿

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/codegraph/agent.rs src-tauri/src/codegraph/mod.rs src-tauri/src/codegraph/types.rs src-tauri/src/codegraph/shard.rs src-tauri/src/codegraph/query/structure.rs
git commit -m "feat(codegraph): agent 查询执行层（状态机 + token 纪律 + 语义门控 + QueryResult.snippet）"
```

---

### Task 6: runtime reader 拦截 codegraph_query 并回写

**Files:**
- Modify: `src-tauri/src/runtime/mod.rs`（stdout reader 任务，约 line 163-247）

**Interfaces:**
- Consumes: `agent::{parse_codegraph_query, execute_agent_query}`（Task 5）、`AgentRuntimeManager.stdin` 的 `Arc<TokioMutex<ChildStdin>>`。
- Produces: reader 对 `codegraph_query` 事件 `continue` 不转发 Vue；异步 spawn 查询任务，结果以 `{"cmd":"codegraph_result","request_id":..., ...payload}` 写回 sidecar stdin。

- [ ] **Step 1: 写失败测试（纯函数部分）**

reader  plumbing 本身不可单测（需要真 sidecar 进程），把可测的响应组装抽成纯函数放进 `agent.rs`：

```rust
/// Assemble the stdin command line payload: base payload + request_id + cmd tag.
pub fn build_result_command(request_id: &str, payload: Value) -> Value {
    let mut v = payload;
    v["cmd"] = Value::String("codegraph_result".into());
    v["request_id"] = Value::String(request_id.into());
    v
}
```

测试（加进 `agent.rs` tests）：

```rust
#[test]
fn build_result_command_tags_cmd_and_request_id() {
    let v = build_result_command("r1", json!({"ok": true, "status": "ready", "results": []}));
    assert_eq!(v["cmd"], "codegraph_result");
    assert_eq!(v["request_id"], "r1");
    assert_eq!(v["status"], "ready");
}
```

- [ ] **Step 2: 确认失败**

Run: `cd src-tauri && cargo test --lib codegraph::agent`
Expected: FAIL（`build_result_command` 未定义）

- [ ] **Step 3: 实现**

3a. 上一步的 `build_result_command` 加进 `agent.rs`。

3b. `runtime/mod.rs`：stdout reader spawn 之前（`let stdin = child.stdin.take()...` 赋值进 `self.stdin` 之后、`tokio::spawn(async move {` 之前）clone 出 stdin Arc，随其他捕获一起 move 进任务：

```rust
// codegraph agent 查询回写通道（reader 拦截 codegraph_query 后用它写回结果）。
let stdin_for_agent = self.stdin.lock().unwrap().as_ref().unwrap().clone();
```

3c. reader 循环内、`image_input_probe_result` 拦截块之后加：

```rust
// codegraph agent 工具查询：Rust ↔ Runtime 内部 request/response，不转发 Vue。
// 查询在独立任务里跑（spawn_blocking），不阻塞 reader 主循环——慢查询
// （大 shard 搜索 / HTTP embed）不能卡住心跳与其他事件的读取。
if let Some(req) = crate::codegraph::agent::parse_codegraph_query(&event) {
    let app2 = app.clone();
    let stdin2 = stdin_for_agent.clone();
    tokio::spawn(async move {
        let payload = tokio::task::spawn_blocking(move || {
            let body = match app2.try_state::<Arc<crate::codegraph::CodeGraphState>>() {
                Some(st) => crate::codegraph::agent::execute_agent_query(
                    st.inner(), &req.tool, &req.args, &req.project_root,
                ),
                None => serde_json::json!({
                    "ok": false, "status": "error",
                    "error": "codegraph state unavailable",
                }),
            };
            crate::codegraph::agent::build_result_command(&req.request_id, body)
        })
        .await;
        if let Ok(mut line) = payload.map(|v| serde_json::to_string(&v)) {
            line.push('\n');
            let mut g = stdin2.lock().await;
            let _ = g.write_all(line.as_bytes()).await;
        }
    });
    continue;
}
```

注意：`st.inner()` 对 `State<'_, Arc<CodeGraphState>>` 返回 `&Arc<CodeGraphState>`，`execute_agent_query` 第一个参数是 `&CodeGraphState`——传 `st.inner().as_ref()` 或调整调用为 `execute_agent_query(st.inner(), ...)` 配合自动 deref；编译器报错就显式 `.as_ref()`。`use tauri::Manager;` 在该作用域已存在（诊断块已用 `try_state`），无需新增 import。

- [ ] **Step 4: 验证**

Run: `cd src-tauri && cargo test --lib` 
Expected: 全绿（含新 `build_result_command` 测试）；`cargo check` 无新 warning

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/runtime/mod.rs src-tauri/src/codegraph/agent.rs
git commit -m "feat(runtime): reader 拦截 codegraph_query，spawn_blocking 查询后回写 stdin"
```

---

### Task 7: sidecar codegraphClient.ts —— request/response 配对

**Files:**
- Create: `agent-sidecar/src/codegraphClient.ts`
- Create: `agent-sidecar/src/codegraphClient.test.ts`
- Modify: `agent-sidecar/src/types.ts`（ChatEvent + SidecarCommand 各加一个变体）

**Interfaces:**
- Consumes: worker 的 `emit`（经 DeltaCoalescer 到 stdout）。
- Produces：
  - `export type CodegraphTool = "find_symbol" | "semantic_search" | "call_graph";`
  - `export interface CodegraphQueryResponse { ok: boolean; status: string; results?: unknown[]; candidates?: number; truncated?: boolean; error?: string; timedOut?: boolean; cancelled?: boolean; }`
  - `export function queryCodegraph(tool: CodegraphTool, args: Record<string, unknown>, projectRoot: string, emit: (e: ChatEvent) => void): Promise<CodegraphQueryResponse>`
  - `export function resolveCodegraphResult(cmd: { request_id: string; ok: boolean; status?: string; results?: unknown[]; candidates?: number; truncated?: boolean; error?: string }): void`
  - `export function cancelAllCodegraphQueries(reason: string): void`
  - `export const CODEGRAPH_QUERY_TIMEOUT_MS = 10_000;`

- [ ] **Step 1: 写失败测试**

创建 `agent-sidecar/src/codegraphClient.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatEvent } from "./types.js";
import {
  queryCodegraph,
  resolveCodegraphResult,
  cancelAllCodegraphQueries,
  CODEGRAPH_QUERY_TIMEOUT_MS,
} from "./codegraphClient.js";

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

afterEach(() => {
  vi.useRealTimers();
  cancelAllCodegraphQueries("test cleanup");
});

describe("codegraphClient", () => {
  it("emits codegraph_query and resolves on matching result", async () => {
    const { events, emit } = emitCollector();
    const p = queryCodegraph("find_symbol", { name: "save" }, "/proj", emit);
    expect(events).toHaveLength(1);
    const q = events[0] as any;
    expect(q.type).toBe("codegraph_query");
    expect(q.tool).toBe("find_symbol");
    expect(q.args).toEqual({ name: "save" });
    expect(q.project_root).toBe("/proj");
    expect(typeof q.request_id).toBe("string");

    resolveCodegraphResult({
      request_id: q.request_id,
      ok: true,
      status: "ready",
      results: [{ file: "a.ts", line: 1 }],
    });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ready");
    expect(r.results).toHaveLength(1);
  });

  it("times out after 10s and reports timedOut", async () => {
    vi.useFakeTimers();
    const { emit } = emitCollector();
    const p = queryCodegraph("find_symbol", { name: "x" }, "/proj", emit);
    await vi.advanceTimersByTimeAsync(CODEGRAPH_QUERY_TIMEOUT_MS + 1);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("ignores results for unknown request_id", () => {
    expect(() =>
      resolveCodegraphResult({ request_id: "nope", ok: true }),
    ).not.toThrow();
  });

  it("cancelAll resolves every pending query as cancelled", async () => {
    const { emit } = emitCollector();
    const p1 = queryCodegraph("find_symbol", { name: "a" }, "/p", emit);
    const p2 = queryCodegraph("call_graph", { name: "b", direction: "callers" }, "/p", emit);
    cancelAllCodegraphQueries("session interrupted");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cancelled).toBe(true);
    expect(r1.error).toContain("interrupted");
    expect(r2.cancelled).toBe(true);
  });

  it("late result after timeout is dropped silently", async () => {
    vi.useFakeTimers();
    const { events, emit } = emitCollector();
    const p = queryCodegraph("find_symbol", { name: "x" }, "/proj", emit);
    await vi.advanceTimersByTimeAsync(CODEGRAPH_QUERY_TIMEOUT_MS + 1);
    await p;
    const q = events[0] as any;
    expect(() =>
      resolveCodegraphResult({ request_id: q.request_id, ok: true, status: "ready" }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd agent-sidecar && npx vitest run src/codegraphClient.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

3a. `types.ts`：`ChatEvent` 联合加（放在 `image_input_probe_result` 附近，并注明 Rust 拦截不转发前端）：

```ts
  // Rust reader 拦截的 agent 代码索引查询（不转发 Vue；响应走 codegraph_result 命令）。
  | {
      type: "codegraph_query";
      request_id: string;
      tool: string;
      args: Record<string, unknown>;
      project_root: string;
    }
```

`SidecarCommand` 联合加：

```ts
  // codegraph agent 查询的应答（Rust → sidecar，按 request_id 配对，无 session 路由）。
  | {
      cmd: "codegraph_result";
      request_id: string;
      ok: boolean;
      status?: string;
      results?: unknown[];
      candidates?: number;
      truncated?: boolean;
      error?: string;
    }
```

3b. 创建 `agent-sidecar/src/codegraphClient.ts`：

```ts
import { randomUUID } from "crypto";
import type { ChatEvent } from "./types.js";

export type CodegraphTool = "find_symbol" | "semantic_search" | "call_graph";

export interface CodegraphQueryResponse {
  ok: boolean;
  status: string;
  results?: unknown[];
  candidates?: number;
  truncated?: boolean;
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (r: CodegraphQueryResponse) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

// SDK 文档：MCP 工具调用超时默认无界（MCP_TOOL_TIMEOUT），所以这里必须自管。
// 10s 对内存查询 + 一次 embed 绰绰有余；超时后 agent 拿文本提示退回 Grep。
export const CODEGRAPH_QUERY_TIMEOUT_MS = 10_000;

export function queryCodegraph(
  tool: CodegraphTool,
  args: Record<string, unknown>,
  projectRoot: string,
  emit: (e: ChatEvent) => void,
): Promise<CodegraphQueryResponse> {
  const request_id = randomUUID();
  // 必须走 worker 的 emit（→ DeltaCoalescer → stdout），禁止直写 process.stdout。
  emit({ type: "codegraph_query", request_id, tool, args, project_root: projectRoot });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      resolve({ ok: false, status: "error", timedOut: true, error: "timeout" });
    }, CODEGRAPH_QUERY_TIMEOUT_MS);
    pending.set(request_id, { resolve, timer });
  });
}

export function resolveCodegraphResult(cmd: {
  request_id: string;
  ok: boolean;
  status?: string;
  results?: unknown[];
  candidates?: number;
  truncated?: boolean;
  error?: string;
}): void {
  const p = pending.get(cmd.request_id);
  if (!p) return; // 未知/已超时/已取消——静默丢弃
  pending.delete(cmd.request_id);
  clearTimeout(p.timer);
  p.resolve({
    ok: cmd.ok,
    status: cmd.status ?? (cmd.ok ? "ready" : "error"),
    results: cmd.results,
    candidates: cmd.candidates,
    truncated: cmd.truncated,
    error: cmd.error,
  });
}

/** 会话停止/中断时清掉该进程内所有挂起查询（request_id 全局唯一，无需按会话分）。 */
export function cancelAllCodegraphQueries(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, status: "error", cancelled: true, error: reason });
  }
  pending.clear();
}
```

- [ ] **Step 4: 跑测试**

Run: `cd agent-sidecar && npx vitest run src/codegraphClient.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/codegraphClient.ts agent-sidecar/src/codegraphClient.test.ts agent-sidecar/src/types.ts
git commit -m "feat(sidecar): codegraphClient request/response 配对（10s 超时 + cancelAll）"
```

---

### Task 8: sidecar codegraphTools.ts —— 三个 MCP 工具 + 文案

**Files:**
- Modify: `agent-sidecar/package.json`（加 zod 依赖）
- Create: `agent-sidecar/src/codegraphTools.ts`
- Create: `agent-sidecar/src/codegraphTools.test.ts`

**Interfaces:**
- Consumes: `queryCodegraph`（Task 7）、`createSdkMcpServer`/`tool`（@anthropic-ai/claude-agent-sdk 0.3.197）、zod ^4。
- Produces：
  - `export const CODEGRAPH_ALLOW_RULE = "mcp__aide-codegraph";`
  - `export function codegraphMcpRegistration(cwd: string, emit: (e: ChatEvent) => void, env?: NodeJS.ProcessEnv): Record<string, unknown> | null`（`AIDE_CODEGRAPH_TOOLS=off` → null）
  - `export function formatToolResponse(tool: CodegraphTool, resp: CodegraphQueryResponse, args: Record<string, unknown>): string`（纯函数，状态文案 + 截断兜底，测试直接打它）
  - MCP server 名固定 `"aide-codegraph"`。

- [ ] **Step 1: 装依赖 + 写失败测试**

```bash
cd agent-sidecar && npm install zod@^4.0.0
```

创建 `agent-sidecar/src/codegraphTools.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  codegraphMcpRegistration,
  formatToolResponse,
  CODEGRAPH_ALLOW_RULE,
} from "./codegraphTools.js";

describe("codegraphMcpRegistration", () => {
  it("returns server spec by default, null when AIDE_CODEGRAPH_TOOLS=off", () => {
    const spec = codegraphMcpRegistration("/proj", () => {}, {} as NodeJS.ProcessEnv);
    expect(spec).not.toBeNull();
    expect(spec!["aide-codegraph"]).toBeDefined();
    const off = codegraphMcpRegistration("/proj", () => {}, {
      AIDE_CODEGRAPH_TOOLS: "off",
    } as NodeJS.ProcessEnv);
    expect(off).toBeNull();
  });

  it("allow rule matches the MCP server name prefix", () => {
    expect(CODEGRAPH_ALLOW_RULE).toBe("mcp__aide-codegraph");
  });
});

describe("formatToolResponse", () => {
  it("no_index guides agent back to Grep", () => {
    const text = formatToolResponse("find_symbol", { ok: true, status: "no_index" }, { name: "x" });
    expect(text).toContain("Grep");
    expect(text.toLowerCase()).toContain("not built");
  });

  it("structure_only explains semantic layer not ready", () => {
    const text = formatToolResponse("semantic_search", { ok: true, status: "structure_only" }, { query: "q" });
    expect(text).toContain("Grep");
  });

  it("timeout and error produce text, never throw", () => {
    expect(formatToolResponse("find_symbol", { ok: false, status: "error", timedOut: true }, { name: "x" })).toContain("timed out");
    expect(formatToolResponse("find_symbol", { ok: false, status: "error", error: "boom" }, { name: "x" })).toContain("boom");
    expect(formatToolResponse("find_symbol", { ok: false, status: "error", cancelled: true, error: "interrupted" }, { name: "x" })).toContain("interrupted");
  });

  it("zero hits says index is healthy but has no match", () => {
    const text = formatToolResponse("find_symbol", { ok: true, status: "ready", results: [] }, { name: "Foo" });
    expect(text).toContain("Foo");
    expect(text.toLowerCase()).toContain("no match");
  });

  it("find_symbol renders one compact line per result", () => {
    const text = formatToolResponse("find_symbol", {
      ok: true, status: "ready",
      results: [{ kind: "Method", name: "save", file: "src/a.ts", line: 42, parent: "UserService" }],
    }, { name: "save" });
    expect(text).toContain("Method save — src/a.ts:42 (UserService)");
  });

  it("call_graph annotates ambiguity and truncation", () => {
    const text = formatToolResponse("call_graph", {
      ok: true, status: "ready", candidates: 3, truncated: true,
      results: [{ peer: "main", peer_defs: ["b.ts:10"], call_file: "b.ts", call_line: 88 }],
    }, { name: "save", direction: "callers" });
    expect(text).toContain("3 candidate definitions");
    expect(text.toLowerCase()).toContain("truncated");
    expect(text).toContain("main (defined at b.ts:10) — called at b.ts:88");
  });

  it("semantic_search marks results as candidates to verify", () => {
    const text = formatToolResponse("semantic_search", {
      ok: true, status: "ready",
      results: [{ name: "login", kind: "Function", file: "auth.rs", line: 10, score: 0.81, snippet: "pub async fn login() {…" }],
    }, { query: "auth" });
    expect(text.toLowerCase()).toContain("candidate");
    expect(text).toContain("auth.rs:10");
  });

  it("oversized semantic snippets are hard-truncated at the formatter", () => {
    const big = "x".repeat(500);
    const text = formatToolResponse("semantic_search", {
      ok: true, status: "ready",
      results: [{ name: "f", kind: "Function", file: "a.ts", line: 1, score: 0.9, snippet: big }],
    }, { query: "q" });
    expect(text.length).toBeLessThan(700);
  });

  it("tool descriptions steer the agent away from Grep (snapshot)", () => {
    const spec = codegraphMcpRegistration("/proj", () => {}, {} as NodeJS.ProcessEnv);
    expect(JSON.stringify(spec)).toMatchSnapshot();
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd agent-sidecar && npx vitest run src/codegraphTools.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

创建 `agent-sidecar/src/codegraphTools.ts`：

```ts
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "./types.js";
import {
  queryCodegraph,
  type CodegraphQueryResponse,
  type CodegraphTool,
} from "./codegraphClient.js";

/** allowedTools 前缀规则：匹配该 server 全部工具，canUseTool 直接跳过（只读工具不弹窗）。 */
export const CODEGRAPH_ALLOW_RULE = "mcp__aide-codegraph";

const SNIPPET_HARD_CAP = 300;

// ---------------------------------------------------------------------------
// 格式化（纯函数，测试直接覆盖）
// ---------------------------------------------------------------------------

function fallbackText(reason: string): string {
  return (
    `Code index unavailable (${reason}). Fall back to Grep/Glob for this query. ` +
    `The user can build the index in Settings → 代码索引.`
  );
}

export function formatToolResponse(
  toolName: CodegraphTool,
  resp: CodegraphQueryResponse,
  args: Record<string, unknown>,
): string {
  // 失败路径全部返回文本——工具报错会让 agent 纠结，文本提示让它自然换路。
  if (resp.timedOut) return fallbackText("query timed out");
  if (resp.cancelled) return fallbackText(resp.error ?? "cancelled");
  if (!resp.ok) return fallbackText(resp.error ?? "unknown error");
  if (resp.status === "no_index" || resp.status === "wrong_project") {
    return fallbackText("index not built for this project");
  }
  if (resp.status === "structure_only") {
    return (
      `The code index's semantic layer is still building (or unavailable), so this ` +
      `semantic query can't run yet. Structure queries (find_symbol, call_graph) work. ` +
      `Fall back to Grep for now.`
    );
  }

  const results = resp.results ?? [];
  if (results.length === 0) {
    const what = (args.name as string) ?? (args.query as string) ?? "";
    return (
      `No match for "${what}" in the code index (the index is healthy — the symbol ` +
      `may not exist, or the project's languages are not covered by the indexer). Try Grep.`
    );
  }

  if (toolName === "find_symbol") {
    const lines = results.map((r: any) => {
      const parent = r.parent ? ` (${r.parent})` : "";
      return `${r.kind} ${r.name} — ${r.file}:${r.line}${parent}`;
    });
    return `Definitions (exact, from code index):\n${lines.join("\n")}`;
  }

  if (toolName === "call_graph") {
    const lines = results.map((r: any) => {
      const defs = r.peer_defs?.length ? ` (defined at ${r.peer_defs.join(", ")})` : "";
      return `${r.peer}${defs} — called at ${r.call_file}:${r.call_line}`;
    });
    const notes: string[] = [];
    if ((resp.candidates ?? 0) > 1) {
      notes.push(
        `⚠ ${resp.candidates} candidate definitions share this name (name-level join) — Read the listed locations to disambiguate.`,
      );
    }
    if (resp.truncated) notes.push(`⚠ Results truncated at ${results.length} rows.`);
    const head = notes.length ? `${notes.join("\n")}\n` : "";
    return `${head}Call graph:\n${lines.join("\n")}`;
  }

  // semantic_search
  const lines = results.map((r: any) => {
    const snippet = String(r.snippet ?? "").slice(0, SNIPPET_HARD_CAP);
    return `${r.kind} ${r.name} — ${r.file}:${r.line} (score ${Number(r.score).toFixed(2)})\n  ${snippet}`;
  });
  return (
    `Semantic matches (vector-similarity CANDIDATES — Read the file to verify before relying on them):\n` +
    lines.join("\n")
  );
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 默认注册；AIDE_CODEGRAPH_TOOLS=off 时返回 null（A/B 实测与调试用，不进设置面板）。
 * server 实例 per-worker 构造：handler 闭包持有该会话的 emit 与 cwd。
 */
export function codegraphMcpRegistration(
  cwd: string,
  emit: (e: ChatEvent) => void,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | null {
  if (env.AIDE_CODEGRAPH_TOOLS === "off") return null;

  const run = async (
    toolName: CodegraphTool,
    args: Record<string, unknown>,
  ) => {
    const resp = await queryCodegraph(toolName, args, cwd, emit);
    return textResult(formatToolResponse(toolName, resp, args));
  };

  const server = createSdkMcpServer({
    name: "aide-codegraph",
    version: "1.0.0",
    tools: [
      tool(
        "find_symbol",
        "Locate the exact definition of a symbol (function/class/method/interface/enum) by name across the indexed project. Returns file:line for each definition. STRONGLY PREFER this over Grep when you need to find where something is defined — one call replaces a grep-then-read fan-out.",
        { name: z.string().describe("Symbol name, e.g. 'makeSkillGuardHook'") },
        async (args) => run("find_symbol", args as Record<string, unknown>),
      ),
      tool(
        "semantic_search",
        "Find code by MEANING when you don't know the identifier: describe what the code does in natural language (e.g. 'permission dialog flow', 'image input handling'). Returns candidate symbols with file:line and a short snippet, replacing iterative keyword grepping. Results are vector-similarity candidates — Read the file to verify before relying on them.",
        {
          query: z.string().describe("Natural-language description of the code you're looking for"),
          limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5)"),
        },
        async (args) => run("semantic_search", args as Record<string, unknown>),
      ),
      tool(
        "call_graph",
        "List callers of / callees of a function or method by name, from the project's pre-built call graph. direction='callers': who calls this symbol; 'callees': what this symbol calls. Much cheaper than grepping every usage site. Name-level join: when candidates>1, multiple definitions share the name — Read the listed locations to disambiguate.",
        {
          name: z.string().describe("Function/method name"),
          direction: z.enum(["callers", "callees"]).describe("'callers' = who calls it; 'callees' = what it calls"),
        },
        async (args) => run("call_graph", args as Record<string, unknown>),
      ),
    ],
  });

  return { "aide-codegraph": server };
}
```

- [ ] **Step 4: 跑测试**

Run: `cd agent-sidecar && npx vitest run src/codegraphTools.test.ts`
Expected: 全过（snapshot 首次自动写入，二次跑确认稳定）

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/package.json agent-sidecar/package-lock.json agent-sidecar/src/codegraphTools.ts agent-sidecar/src/codegraphTools.test.ts
git commit -m "feat(sidecar): 三个 codegraph MCP 工具 + 状态文案 + token 截断兜底"
```

---

### Task 9: sidecar 注册接线 —— SessionWorker + SessionManager

**Files:**
- Modify: `agent-sidecar/src/session-worker.ts`（query options 注册 mcpServers + allowedTools；stop/interrupt 时 cancelAll）
- Modify: `agent-sidecar/src/session-manager.ts`（handleCommand 加 codegraph_result 分支）
- Modify: `agent-sidecar/src/session-worker.test.ts`（注册断言）

**Interfaces:**
- Consumes: `codegraphMcpRegistration`、`CODEGRAPH_ALLOW_RULE`（Task 8）、`resolveCodegraphResult`、`cancelAllCodegraphQueries`（Task 7）。
- Produces: 会话 query options 含 `mcpServers: { "aide-codegraph": ... }`；`allowedTools` 含 `mcp__aide-codegraph`；Rust 回包按 request_id 结算。

- [ ] **Step 1: 写失败测试**

`session-worker.test.ts` 现有模式是 `new SessionWorker(sid, (e) => events.push(e), { queryFn: fakeQueryFn, ... })`。新增：fake queryFn 捕获 options，断言注册。先看该文件里 `startLoop` 怎么被测试驱动（若现有测试不触发 startLoop，则把 options 组装里 mcpServers 的决策抽成可测点）。采取稳妥做法——测试 `codegraphMcpRegistration` 已在 Task 8 覆盖，这里只测 worker 集成点：

在 `session-worker.test.ts` 追加（适配现有 helper，若构造签名不同按现有测试调整）：

```ts
it("registers aide-codegraph MCP server and allow rule in query options", async () => {
  let captured: any;
  const fakeQuery = ((opts: any) => {
    captured = opts?.options ?? opts;
    // 返回一个永不产出消息的空 async iterable
    return (async function* () {})();
  }) as any;
  const worker = new SessionWorker("s-cg", () => {}, { queryFn: fakeQuery, cwd: "/proj" });
  void worker.startLoop("/proj");
  await new Promise((r) => setTimeout(r, 50));
  worker.stop();
  expect(captured?.mcpServers?.["aide-codegraph"]).toBeDefined();
  expect(captured?.allowedTools).toContain("mcp__aide-codegraph");
});

it("AIDE_CODEGRAPH_TOOLS=off skips MCP registration", async () => {
  process.env.AIDE_CODEGRAPH_TOOLS = "off";
  try {
    let captured: any;
    const fakeQuery = ((opts: any) => {
      captured = opts?.options ?? opts;
      return (async function* () {})();
    }) as any;
    const worker = new SessionWorker("s-cg-off", () => {}, { queryFn: fakeQuery, cwd: "/proj" });
    void worker.startLoop("/proj");
    await new Promise((r) => setTimeout(r, 50));
    worker.stop();
    expect(captured?.mcpServers?.["aide-codegraph"]).toBeUndefined();
  } finally {
    delete process.env.AIDE_CODEGRAPH_TOOLS;
  }
});
```

注：`SessionWorkerOptions.queryFn` 与 `stop()` 的现有签名以 `session-worker.test.ts` 里既有用法为准；若 `startLoop` 需要 prompt 队列先非空，参照现有测试先 `handleCommand` 一个 send。

- [ ] **Step 2: 确认失败**

Run: `cd agent-sidecar && npx vitest run src/session-worker.test.ts`
Expected: 新 2 个 FAIL（mcpServers 未注册）

- [ ] **Step 3: 实现**

3a. `session-worker.ts` import 加：

```ts
import { codegraphMcpRegistration, CODEGRAPH_ALLOW_RULE } from "./codegraphTools.js";
import { cancelAllCodegraphQueries } from "./codegraphClient.js";
```

3b. `startLoop` 里 query options 组装（约 line 663-697）：`const skillGuardHook = ...` 之后加：

```ts
// codegraph agent 工具：默认注册（AIDE_CODEGRAPH_TOOLS=off 关闭）。
// handler 闭包持有本会话的 emit（经 DeltaCoalescer，红线）与 cwd。
const effectiveCwd = cwd ?? this.cwd ?? "";
const codegraphMcp = codegraphMcpRegistration(effectiveCwd, (e) => this.emit(e));
```

options 对象里加两行：

```ts
...(codegraphMcp ? { mcpServers: codegraphMcp as any } : {}),
...(this.lightweightMode
  ? { allowedTools: [] as string[] }
  : { allowedTools: ["Agent", "Task", CODEGRAPH_ALLOW_RULE] }),
```

3c. `stop()` 与 interrupt 路径加 `cancelAllCodegraphQueries("session stopped"/"interrupted")`——找到 `stop()` 方法（调 `q.close()` 处）和 `handleCommand` 的 interrupt 分支，各加一行调用。

3d. `session-manager.ts` `handleCommand` 顶部、`probe_image_input` 分支后加：

```ts
if (cmd.cmd === "codegraph_result") {
  resolveCodegraphResult(cmd as any);
  return;
}
```

import 加 `import { resolveCodegraphResult } from "./codegraphClient.js";`。

- [ ] **Step 4: 跑测试 + 构建**

Run: `cd agent-sidecar && npx vitest run`
Expected: 全绿
Run: `cd agent-sidecar && npm run build`
Expected: esbuild 成功出 `dist/runtime.js`

- [ ] **Step 5: Commit**

```bash
git add agent-sidecar/src/session-worker.ts agent-sidecar/src/session-worker.test.ts agent-sidecar/src/session-manager.ts agent-sidecar/dist/runtime.js
git commit -m "feat(sidecar): 会话注册 codegraph MCP 工具 + allowedTools 自动放行 + 结果路由"
```

注：仓库惯例 `dist/runtime.js` 需重建提交（见 memory「aide 仓库怪癖」）。

---

### Task 10: A/B 实测验收 + 报告

**Files:**
- Create: `docs/superpowers/reports/2026-07-25-codegraph-agent-tools-ab.md`

**Interfaces:**
- Consumes: Task 1-9 全部；`TurnUsage` 用量面板；`AIDE_CODEGRAPH_TOOLS=off`。
- Produces: 验收报告（过/不过 + 数据表 + 迭代项）。

这是人工 E2E 任务，无单测；按步骤执行并记录。

- [ ] **Step 1: 重建 sidecar 并重启 dev**

```bash
cd agent-sidecar && npm run build && cd .. && pnpm tauri dev
```

- [ ] **Step 2: 建索引**

在 aide 里打开 aide 仓库自身的工作区 → 设置 → 代码索引 → 构建，等 embed 完成（`has_embeddings: true`）。

- [ ] **Step 3: A 臂（工具开）跑三任务**

各开**全新会话**，同一模型，依次发：
1. 探索型：「理清 aide 权限弹窗从 canUseTool 到用户点击的完整链路」
2. 语义型：「找到处理图片输入能力的代码并说明工作流程」
3. 实现型对照：「给设置面板加一个小开关」

每任务记录：总工具调用数、Grep/Glob/Read 次数、`mcp__aide-codegraph__*` 调用次数、累计 input token（用量面板）、结果质量简评。

- [ ] **Step 4: B 臂（工具关）复跑**

```bash
AIDE_CODEGRAPH_TOOLS=off pnpm tauri dev
```

全新会话复跑同样三任务（逐字相同 prompt），同样记录。

- [ ] **Step 5: 对照验收线并写报告**

验收线（spec §9）：任务 1、2 的 Grep/Read 调用数下降 ≥40% 且 input token 显著下降；任务 3 无劣化；A 臂转录里 `mcp__aide-codegraph__*` 实际出现。
报告落 `docs/superpowers/reports/2026-07-25-codegraph-agent-tools-ab.md`：数据表 + 结论（过/不过）+ 不达标时的迭代项（工具描述/输出格式/结果排序）。

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/reports/2026-07-25-codegraph-agent-tools-ab.md
git commit -m "test: codegraph agent tools A/B 实测报告"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1 架构 → Task 6/7；§2 协议 → Task 7(types)/9；§3.1 EdgeTable → Task 1；§3.2 caller 修复 → Task 2；§3.3 接线 → Task 3；§3.4 calls 查询 → Task 4；§3.5 token 纪律 → Task 4/5/8；§3.6 执行点 → Task 5/6；§4.1 client → Task 7；§4.2 tools → Task 8；§4.3 注册/放行/env → Task 9；§5 权限 UI → Task 9（UI 走通用通道无需任务）；§6 错误矩阵 → Task 5/7/8；§7 测试 → 各任务内嵌；§9 A/B → Task 10。
- **类型一致性**：`EdgeTable::{callers_of, callees_of, insert, remove_file, save_json, load_json, len}` 在 Task 1/3/4/5 一致；`execute_agent_query(&CodeGraphState, &str, &Value, &str) -> Value` 在 Task 5/6 一致；`queryCodegraph/resolveCodegraphResult/cancelAllCodegraphQueries` 在 Task 7/8/9 一致；`codegraphMcpRegistration`/`CODEGRAPH_ALLOW_RULE`/`formatToolResponse` 在 Task 8/9 一致；`QueryResult.snippet` 扩展（types/shard/structure 三处）在 Task 5 内闭合。
- **已核实落地**：`shard.rs` payload 存 `code_snippet` 但 search 未读出（Task 5 已给精确三处改法）；被拦截事件不进前端类型（image probe 先例，已验证）。
