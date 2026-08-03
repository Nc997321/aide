# codegraph 返回符号跨度与源码 — 实现计划

- 日期：2026-08-03
- 状态：草案，待实施
- 关联：`docs/superpowers/specs/2026-07-10-codegraph-design.md`、`docs/reference/codegraph-agent-tools-playbook.md`

## 1. 背景与动机

agent 用 codegraph 三件套定位符号后，用 Read 读上下文。Read 的 `limit` 由 agent 手填、无依据，常"怕读漏多给"——一次权限弹窗链路探索 Read ~1086 行，理想只需 ~414 行（2.6×），浪费约 550 行，且随每轮上下文重发。

根因：codegraph 索引时 tree-sitter 解析 AST，符号节点天然带 `start_position()` / `end_position()`（span），但当前**提取只取 start、存储只存 start、查询只返回 start、展示只输出 start——端到端四层都没暴露 end_line**。agent 拿不到函数跨度，只能瞎猜 limit。

## 2. 目标（更优方案）

不止返回 `end_line`，直接让 codegraph **返回符号完整源码**：索引已有/将有 span，codegraph 按 `[start_line, end_line]` 从源文件切出源码塞进结果。agent 拿到的就是"这个函数的完整代码"，**不用调 Read、不算 limit**，省一轮工具往返。

分两阶段，阶段 1 是阶段 2 的基础设施。

## 3. 现状缺口证据

| 层 | file:line | 现状 |
|---|---|---|
| 存储 | `src-tauri/src/codegraph/types.rs:25-37` SymbolDef | 字段 `name/kind/file/line/column/parent`，无 end_line |
| 提取 | `src-tauri/src/codegraph/indexer/extract.rs` 12 处 `SymbolDef {` 构造 | 只 `node.start_position()`，从不调 `end_position()`（全模块 0 命中） |
| 查询 | `src-tauri/src/codegraph/agent.rs:104-111` find_symbol | results 只放 `kind/name/file/line/parent` |
| 查询 | `src-tauri/src/codegraph/agent.rs:177-186` semantic | results 含 `symbol` + 截断 snippet，无 end_line |
| 展示 | `agent-sidecar/src/codegraphTools.ts:118` | 只输出 `${file}:${line}` |

## 4. 方案设计

### 阶段 1：end_line 基础设施

**4.1 存储**（`types.rs:25-37`）
SymbolDef 加 `pub end_line: usize`，标 `#[serde(default)]`（旧索引兼容，见 §6）。

**4.2 提取**（`indexer/extract.rs` 12 处 `SymbolDef {` 构造）
每处加 `end_line: node.end_position().row + 1`。tree-sitter `Node::end_position()` 是现成 API，零成本。已确认全模块从未调用过 `end_position`，属新引入。

**4.3 查询**（`agent.rs`）
- find_symbol（104-111）：results 加 `"end_line": r.symbol.end_line`
- semantic（177-186）：results 加 `"end_line": r.symbol.end_line`（`r` 是 `QueryResult`，`r.symbol` 即 `SymbolDef`）
- call_graph：**不动**——call site 是单行调用，跨度无意义

**4.4 展示**（`codegraphTools.ts:118`）
find_symbol 格式改为 `${kind} ${name} — ${file}:${line}-${end_line}${parent}`（或附 `(N行)`）。

### 阶段 2：返回符号源码

**4.5 新增切片能力**
codegraph 查询时，对 find_symbol 的每个 hit，按 `symbol.file` + `[line, end_line]` 从源文件切出源码，塞进 results 的 `source` 字段（带行号，capped）。

实现：抽 helper `read_symbol_source(symbol, project_root, cap) -> Option<String>`，建议放 `query/structure.rs`（与 `structure_lookup:10` 同模块）。逻辑：
- 路径 = `project_root.join(&symbol.file)`（symbol.file 是项目相对路径，正斜杠）
- `fs::read_to_string` → `lines().skip(line-1).take(end_line - line + 1)` 拼带行号块
- cap：若 `end_line - line + 1 > MAX_SOURCE_LINES`（如 200）或字节 > `MAX_SOURCE_BYTES`（如 8KB），返回 `None`（回退只给 span）

**4.6 展示源码**（`codegraphTools.ts`）
find_symbol 结果在 `file:line-end_line` 后附源码块，agent 直接看，不必 Read。源码为空（超 cap）时回退：只给 span，agent 用 `end_line` 精准 Read（`limit = end_line - line + 1 + 余量`）。

**4.7 semantic 分支**
semantic 已有截断 snippet（来自 embed 时的 `IndexedPoint.code_snippet`，types.rs:54，是签名+body 开头、非完整函数）。阶段 2 可让 semantic 也按 span 切完整源码替换 snippet，优先级低于 find_symbol（semantic 候选本就要 Read 验证）。

## 5. 改动点清单

| # | 文件:行 | 改什么 | 阶段 | 行数 |
|---|---|---|---|---|
| 1 | `types.rs:25-37` | SymbolDef 加 `end_line` + `#[serde(default)]` | 1 | ~3 |
| 2 | `indexer/extract.rs` 12 处 | 每处加 `end_line: node.end_position().row+1` | 1 | ~12 |
| 3 | `agent.rs:104-111` | find_symbol results 加 `end_line` | 1 | 1 |
| 4 | `agent.rs:177-186` | semantic results 加 `end_line` | 1 | 1 |
| 5 | `codegraphTools.ts:118` | find_symbol 格式带 `end_line` | 1 | 1 |
| 6 | `symbols.rs:85` 测试 helper `sym()` | 加 `end_line` 字段 + 相关断言 | 1 | ~5 |
| 6.5 | `indexer/extract.rs:503-572` | Vue SFC 行号偏移修复：`extract_script_block` 返回 `(content, start_line)`，`extract_vue_sfc` 对 script 衍生符号 line/end_line 加偏移 | 1 | ~12 |
| 7 | `query/structure.rs` + `agent.rs` | `read_symbol_source` helper + find_symbol 调用塞 `source` | 2 | ~20 |
| 8 | `codegraphTools.ts` | find_symbol 结果附源码块（含 cap 回退） | 2 | ~15 |

## 6. 索引兼容性

SymbolDef 加字段后，`symbols.rs:68-77` 的 `save_json/load_json` 旧索引 json 反序列化会缺 `end_line`。
- **方案**：`#[serde(default)]` 让 `end_line` 默认 0。旧索引无痛加载（end_line=0 → 不显示跨度/不切源码，回退旧行为），新索引才有完整 span。**无破坏性，不强制重建**。
- 避免强制重建：按 [[aide-codegraph-embed-complete-shard-panic]] 可能踩脏 shard 复用 → qdrant panic 的坑（虽已修，能避则避）。

## 7. 风险点

1. **extract.rs 12 处遗漏** — 漏改某节点类型 → 该类符号 end_line=0。靠 serde default 兜底（不崩，只是无跨度）+ 测试覆盖各 SymbolKind（Function/Method/Class/Field/Interface/Enum/Variable + Rust struct/enum/impl/trait + Vue SFC）。
2. **源码切片 IO** — ✅ 已验证排除：`execute_agent_query` 在 `tokio::spawn + spawn_blocking` 任务里跑（`runtime/mod.rs:243-244`，注释明言"不阻塞 reader 主循环"），**不在 Tauri 主线程**。阶段 2 源码切片 IO 同在此任务，**无需额外 `spawn_blocking`**。唯一注意：find_symbol 当前在 `st.inner.read()` 锁内构造 results（`agent.rs:87-113`），切片 IO 应**移到锁外**——先锁内收 hits（file/line/end_line），drop guard，再锁外切片读源码，避免延长锁持有阻塞其他查询。cap 体积（≤200 行/8KB）防巨型函数灌爆上下文；超 cap 回退只给 span。
3. **Vue SFC 行号基准** — ✅ 已验证成立（现有 bug）：`extract_vue_sfc`(`extract.rs:503`) 把 `extract_script_block` 返回的 script block 文本单独 parse（:548 `parser.parse(&script_content, None)`），`extract_from_node` 用 `script_content` 而非 SFC 全文（:551）。tree-sitter 给的 row 是**相对 `script_content` 的偏移**，所以 script block 内符号的 `line` 是 script block 内偏移、**非 SFC 全文行号**。文件名衍生组件符号（:530 `line:1`）是 SFC 全文行号、无此问题。agent 用偏移 line 去 Read SFC 会读错位置——现有 bug，加 end_line 会让切片也错。**阶段 1 必须一并修**（改动点 6.5）：`extract_script_block`(:567) 改返回 `(content, start_line_1based)`（start_line = `source[..content_start]` 换行数 +1），`extract_vue_sfc` 对 script block 衍生符号的 line/end_line 加 `start_line - 1` 偏移（文件名衍生符号 line=1 不参与）。
4. **路径前缀** — symbol.file 是项目相对正斜杠路径，切片 join project_root 即可；注意 Windows `\\?\` verbatim 路径坑（[[tauri-resource-dir-verbatim-path]]）——但 codegraph 索引文件用项目根 PathBuf，不经 resource_dir，不受影响。

## 8. 验收标准

- [ ] find_symbol 返回每个结果带 `end_line`（新索引）；旧索引 end_line=0 不崩、回退旧行为。
- [ ] extract.rs 12 处构造点全覆盖（各 SymbolKind 测试 end_line > 0）。
- [ ] 阶段 2：find_symbol 结果含源码块（≤cap），agent 拿到后无需 Read 即可看完整函数。
- [ ] 大函数超 cap：回退只给 span，agent 用 `end_line` 精准 Read（`limit = end_line-line+1+余量`）。
- [ ] codegraph 现有测试全绿（`cargo test --lib` 绕杀软锁，按 [[aide-repo-quirks]]）。
- [ ] 手测：一次链路探索的 Read 行数从 ~1086 降到接近 ~414（阶段 1，精准 limit）；阶段 2 后更低（许多函数不再 Read）。

## 9. 工作量估算

- 阶段 1：~37 行，5 文件，3-4 小时（含 Vue SFC 偏移修复 + 测试）。
- 阶段 2：~35 行，2 文件，2-3 小时（含 cap/回退；IO 上下文已验证无需 spawn_blocking）。
- 合计 ~60 行，~5 小时。无算法复杂度，机械改动 + 切片逻辑。

## 10. 不做

- call_graph 的 call site 不加 end_line（单行调用，跨度无意义）。
- 不强制重建索引（serde default 兼容旧索引）。
- 不改 codegraph MCP 工具的入参 schema（`end_line`/`source` 是返回内容字段，非工具入参）。
- 不动 semantic 的 embed 时 code_snippet（阶段 2 仅在查询返回时按 span 切完整源码，不改索引存储的 snippet）。

## 11. 后续可选

- 阶段 2 稳定后，评估把"返回符号源码"包装成独立工具 `read_symbol`（给符号名直接返回源码），让 agent 显式调用而非附在 find_symbol 结果里——进一步减少 find_symbol 结果体积（按需取源码而非总带）。