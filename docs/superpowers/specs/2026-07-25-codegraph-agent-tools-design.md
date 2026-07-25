# CodeGraph Agent Tools 设计：把内置索引暴露为 AI Agent 工具

2026-07-25 · 状态：待评审

## 背景与目标

aide 的 CodeGraph（`src-tauri/src/codegraph/`）已建成完整的索引基础设施：tree-sitter 解析（Java/TS/JS/TSX/Python/Rust/Vue）、内存符号表（结构层）、Qdrant Edge 向量库（语义层）、两阶段构建、增量 reindex、可插拔 embedder。但当前**只有编辑器 UI 消费它**（goto-definition / 查找引用），AI agent 完全吃不到——会话探索代码仍走 Grep/Read 扇出老路，每个项目每次会话重复烧「发现阶段」的 token。

本 feature 把索引暴露为 agent 可直接调用的三个工具，目标是把导航类工具调用（找定义、找调用方、按概念定位代码）从「grep + 多次 read」折叠为单次精确查询。

**非目标**：
- 不做独立 MCP server 进程（不开端口、不新增子进程）。
- 不追求类型级调用图（tree-sitter 无类型推断，名字级联接是诚实的上限，结果标注候选）。
- 第一期不做前端定制渲染（工具调用走现有通用工具卡）。
- 不扩展语言覆盖（维持现有 5 族；未覆盖语言 agent 自然退回 grep）。

## 成功标准（A/B 实测，写死）

工具做完不算完，数据达标才算。方法见 §9。**验收线**：

1. 探索型/语义型任务：Grep/Read 调用数下降 ≥40%，累计 input token 显著下降；
2. 实现型对照任务：无劣化；
3. 转录中可见 agent 实际调用了 `mcp__aide-codegraph__*` 工具。

不达标 → 迭代工具描述与输出格式，不宣布完工。

## 1. 架构与数据流

```
Claude ──调用 mcp__aide-codegraph__find_symbol──▶ SessionWorker 内的 SDK MCP server
                                                        │ handler 挂起 Promise（pending map，10s 超时 + abort）
                                                        ▼ stdout（经 worker emit → DeltaCoalescer，非增量事件透传保序）
                                        { type:"codegraph_query", request_id, tool, args, project_root }
                                                        │
Rust stdout reader 拦截（不转发 Vue——image_input_probe_result 同款先例）
                                                        ▼ spawn_blocking 读 CodeGraphState（app.state::<Arc<_>>）
                                                        │ stdin（clone 进 reader 任务的 Arc<TokioMutex<ChildStdin>>）
                                        { cmd:"codegraph_result", request_id, ok, status, results }
                                                        ▼
                          sidecar codegraphClient 结算 Promise → 格式化紧凑文本 → CallToolResult 返回 Claude
```

要点：

- 单 runtime 进程、多会话共享；`request_id`（UUID）做配对键，天然支持并发与跨会话。
- 查询全在内存（符号表/边表）+ 本地 shard；语义查询多一次 embed（本地 ONNX ~50–200ms 或 HTTP embedder）。
- 协议字段全部是符号名/路径/查询串/方向——无任何 Claude 专属概念。**provider-agnostic 红线**：未来新 provider 的 sidecar 实现同一对 `codegraph_query`/`codegraph_result` 即获得同样能力；工具注册（MCP server）是 Claude sidecar 的 provider 专属部分，新 provider 用各自机制注册同名工具。

## 2. IPC 协议扩展

**事件**（sidecar→Rust，`ChatEvent` 新增）：

```jsonc
{
  "type": "codegraph_query",
  "request_id": "uuid",
  "tool": "find_symbol" | "semantic_search" | "call_graph",
  "args": { /* 各工具参数，见 §5 */ },
  "project_root": "C:/work/proj"   // 取会话 cwd，Rust 校验活跃索引匹配
}
```

注：`session_id` 由 `emitToStdout` 统一注入路由键，不在事件体里重复。

**命令**（Rust→sidecar，`SidecarCommand` 新增）：

```jsonc
{
  "cmd": "codegraph_result",
  "request_id": "uuid",
  "ok": true,
  "status": "ready" | "structure_only" | "no_index" | "wrong_project" | "error",
  "results": [ /* 查询结果行，结构随 tool */ ],
  "error": "..."                    // ok=false 时
}
```

- `status` 由 Rust 给结构化状态，**文案由 sidecar 工具层统一组装**（给 LLM 看的提示语集中在 sidecar，Rust 不措辞）。
- sidecar `SessionManager.handleCommand` 在 session 路由前加 `codegraph_result` 分支（同 `probe_image_input` 先例），按 `request_id` 结算全局 pending map——不带 session_id，不需要 worker 路由。

## 3. Rust 层改动

### 3.1 EdgeTable（新文件 `codegraph/edges.rs`）

调用边的一等存储，API 对齐 `SymbolTable`：

- 双索引：`by_callee: HashMap<String, Vec<CallEdge>>` + `by_caller: HashMap<String, Vec<CallEdge>>`。
- `insert / remove_file / len / save_json / load_json`，落盘 `edges.json` 与 `symbols.json` 同级。
- `ProjectIndex` 增加 `edges: EdgeTable` 字段。

### 3.2 修复 extract：填 caller（核实发现的真缺口）

现状：`extract.rs` 的调用节点分支把 `CallEdge.caller` 推为 `String::new()`，注释写「resolved by context」但**无任何代码填它**。不修则 `callees(X)` 不可能、`callers(X)` 说不出谁在调。

修法：递归已穿 `parent_sym`（所属类），照同款模式再穿 `current_fn: Option<&str>`（所属函数/方法名），进入函数/方法定义节点时更新，生成边时填入。模块顶层调用的 caller 记为 `""`，查询输出标 `(顶层)`。

### 3.3 接线两处丢弃点

- `indexer.rs::build_structure_index`（~line 80）与 `reindex_one`（~line 331）的 `(points, _edges)` 改为存入 EdgeTable；`reindex_one` 先 `edges.remove_file` 再插入新边（与符号表同步增量）。
- 持久化：build/reindex 写 `edges.json`；`load_project_index`/`load_compatible_index` 加载失败（含**旧索引无 edges.json**）→ 走现有「不兼容即全量重建」路径，不静默降级。升级后首次打开旧项目会一次性重建，可接受。

### 3.4 新查询 `query/calls.rs`

- `callers(name)`：`by_callee` 找边 → caller 名回 `SymbolTable` 反查定义（拿 kind/位置）；输出行形如 `UserService.save(src/service.ts:42) 调用于 src/handler.ts:88`。
- `callees(name)`：`by_caller` 找边 → callee 名反查定义。
- **名字级歧义不藏**：callee 名对应多个定义时结果带 `candidates: N` 标注 + 各候选定义位置，引导 agent 定向 Read 消歧，而不是假装精确。

### 3.5 输出 token 纪律（硬约束，写在查询层）

| 工具 | 上限 | 格式 |
|---|---|---|
| `find_symbol` | 20 条 | 每条一行 `kind name — path:line (parent)` |
| `semantic_search` | 默认 5 / 上限 10 条 | snippet 裁到签名+开头 ≤300 字符，带 score，统一标「候选需核实」 |
| `call_graph` | 单方向 30 条边 | 每条一行 |

目标：单次工具结果 ≤2KB。sidecar 格式化层再做一次截断兜底（双保险）。

### 3.6 查询执行点

Rust reader 拦截 `codegraph_query` 后 `spawn_blocking`：

1. `app.try_state::<Arc<CodeGraphState>>()` 取状态（`lib.rs:101` 已按 Arc 注册）；
2. 校验 `project_root` 匹配活跃索引（不匹配 → `wrong_project`）；
3. 读锁取结构层结果；语义查询按 `embed_ready` 门控（未就绪 → `structure_only`，sidecar 措辞「语义层未就绪，退回 Grep」），embed 需锁 embedder（同 `codegraph_goto_definition` 现有模式）；
4. 组装 `codegraph_result`，经 clone 进 reader 任务的 stdin Arc 写回（`AgentRuntimeManager.stdin` 已有 `Arc<TokioMutex<ChildStdin>>`，spawn reader 前 clone 一份）。

reader 对 `codegraph_query` `continue` 不转发 Vue（同 `image_input_probe_result`）。

## 4. Sidecar 层改动

### 4.1 `codegraphClient.ts`（新文件）

request/response 配对的模块级单例：

- `query(tool, args, projectRoot, emit, signal): Promise<QueryResponse>`：生成 `request_id`，经 worker emit 发 `codegraph_query`（**必须走 emit → DeltaCoalescer，禁止直写 stdout**——红线），挂 pending（`resolve` + 10s 定时器 + abort listener）。
- `resolveResult(cmd)`：被 `SessionManager.handleCommand` 的 `codegraph_result` 分支调用，按 `request_id` 结算。
- 超时 → 返回「索引查询超时，请退回 Grep」；abort（interrupt）→ 立即结算取消文案。**任何失败路径都返回文本而非抛错**——工具报错会让 agent 纠结，文本提示让它自然换路。
- SDK 文档确认 MCP 工具调用超时默认无界（`MCP_TOOL_TIMEOUT`），handler 自管 10s 是必需不是可选。

### 4.2 `codegraphTools.ts`（新文件）

`createSdkMcpServer({ name: "aide-codegraph", version, tools: [...] })`，三个工具（zod schema；zod 加为 sidecar 直接依赖，版本对齐 SDK 的 `^4.0.0`）：

| 工具 | 参数 | 用途 |
|---|---|---|
| `find_symbol` | `name: string` | 精确定义跳转，替代「grep 找定义」 |
| `semantic_search` | `query: string, limit?: number` | 知道概念不知道标识符时定位代码 |
| `call_graph` | `name: string, direction: "callers" \| "callees"` | 调用方/被调方枚举（候选集，带位置供定向 Read） |

**工具描述当 prompt 工程写**（引导 agent 改 grep 习惯的主要杠杆）：明确「查符号定义/调用关系时优先用此工具，不要为定位代码发起 Grep；语义/调用图结果是候选，关键文件用 Read 核实」。描述文案进测试快照，改动需刻意。

格式化：把 `results` + `status` 组装为紧凑文本（§3.5 纪律的 sidecar 兜底）；`no_index`/`wrong_project`/`structure_only` → 「索引未构建/语义层未就绪，请退回 Grep；用户可在设置-代码索引构建」。

### 4.3 注册点（`session-worker.ts` ~line 665 query options）

- `mcpServers: { "aide-codegraph": makeCodegraphServer(...) }`（server 实例 per-worker 构造，handler 闭包持有 worker 的 emit 与 cwd）。
- **自动放行**：`allowedTools` 加 `"mcp__aide-codegraph"`——服务名前缀匹配该 server 全部工具，`canUseTool` 直接跳过（`index.ts` 顶部注释证实此机制正是 Agent/Task 不弹窗的原理）。三个工具全只读，弹窗确认纯属打断。
- btw 轻量模式 `tools: []` 天然禁用 MCP 工具，支线对话不受影响，无需特判。
- **A/B 开关**：`AIDE_CODEGRAPH_TOOLS=off` 环境变量 → 不注册 MCP server。仅测试/调试用，不进设置面板。

## 5. 权限与 UI

- 权限：见 §4.3，`allowedTools` 前缀规则自动放行，不碰 `permissions.ts` 主流程。
- UI：`tool_use_start`/`tool_result` 走 mapper 现有通用通道（`block.name` 原样透传），前端自然渲染为工具调用卡。第一期不做定制渲染（YAGNI）。

## 6. 错误处理矩阵

| 场景 | 行为 |
|---|---|
| 索引未构建 | Rust `status:"no_index"` → sidecar 文案引导退回 Grep + 提示设置里构建 |
| project_root 不匹配活跃索引 | `wrong_project` → 同上 |
| embed 未就绪（语义工具） | `structure_only` → 「语义层未就绪」文案；结构类工具不受影响 |
| Rust 10s 未响应 | sidecar 超时结算 → 「超时，退回 Grep」 |
| 会话被 interrupt | abort 立即结算取消文案 |
| Rust 查询内部错误（锁中毒等） | `ok:false,error` → 「索引暂不可用，退回 Grep」 |
| 旧索引无 edges.json | 加载不兼容 → 全量重建（一次性） |
| 未覆盖语言（Go/C# 等） | 索引正常但零命中：`ok:true, status:"ready", results:[]` → sidecar 文案「索引中未找到该符号（可能该项目语言未被索引覆盖），请改用 Grep」 |

补充约定：零命中与索引不可用是**两种不同语义**——前者索引健康只是没查到，agent 可直接换 Grep 重试；后者提示用户去设置构建。sidecar 格式化时必须区分这两条文案，不得合并。

所有路径保证：工具**返回文本**，绝不抛错、绝不挂起（超时兜底）、绝不阻塞会话。

## 7. 测试策略

**Rust 单测**：
- EdgeTable：insert/remove_file/持久化 round-trip/双索引一致性；
- extract caller 修复：函数内调用边带 caller、方法内带 caller、顶层调用 caller 为空；
- `query/calls.rs`：callers/callees 基本查询、多名定义歧义标注、顶层调用标 `(顶层)`；
- build/reindex 接线后边表与符号表一致；旧索引（无 edges.json）触发全量重建。

**Sidecar 单测**：
- codegraphClient：正常结算 / 10s 超时 / abort / 未知 request_id 丢弃；
- codegraphTools：各 `status` 分支文案、超长 snippet 截断兜底、工具描述快照；
- 注册：`AIDE_CODEGRAPH_TOOLS=off` 时 query options 无 `mcpServers`；`allowedTools` 含 `mcp__aide-codegraph`。

**E2E**：§9 A/B 三任务人工跑。

## 8. 工作量分布（自评）

| 部分 | 量级 |
|---|---|
| Rust：EdgeTable + extract caller 修复 + calls 查询 + 接线 + reader 拦截回写 | 主要工作量，extract 修复最需细心（递归上下文穿透） |
| Sidecar：client + tools + 注册 + 测试 | 中等，模式全是现成的（pending map 仿 permissions.ts） |
| A/B 实测 | 3 任务 × 2 臂人工跑 + 写报告 |

## 9. A/B 验收方案

**任务集**（同一模型、全新会话、各跑有/无工具两臂；无工具臂用 `AIDE_CODEGRAPH_TOOLS=off`）：

1. **探索型**：「理清 aide 权限弹窗从 canUseTool 到用户点击的完整链路」
2. **语义型**：「找到处理图片输入能力的代码并说明工作流程」（标识符未知）
3. **实现型对照**：「给设置面板加一个小开关」（预期收益小，验证无副作用）

**度量**：总工具调用数、Grep/Glob/Read 调用数、累计 input token（`TurnUsage` 面板现成）、任务完成质量（人工判）、转录中 `mcp__aide-codegraph__*` 出现次数。

**结果**：写成报告落 `docs/`（数字表 + 结论 + 不达标时的迭代项）。

## 10. 风险与开放问题

- **agent 不用工具**：最大风险。缓解=工具描述 prompt 工程 + A/B 验收兜底（用了多少、省了多少都量化）；若使用率不足，迭代描述/在结果文案里强化引导。
- **名字级调用图歧义**：多定义同名时结果是候选集。已通过 `candidates: N` + 位置输出诚实标注，引导定向 Read——仍比全文件 grep 省。
- **大项目语义查询延迟**：embedder 锁串行化 embed，单查询 ~50–200ms（ONNX）可接受；HTTP embedder 更快。
- **升级一次性全量重建**：旧索引无 edges.json → 首次打开重建，大项目有一次性等待，可接受（结构层先就绪）。
