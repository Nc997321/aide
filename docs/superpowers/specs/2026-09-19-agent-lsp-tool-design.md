# Agent LSP 工具设计

日期：2026-09-19
状态：设计待评审
基线证据：[docs/superpowers/spikes/2026-09-19-lsp-agent-tools/README.md](../spikes/2026-09-19-lsp-agent-tools/README.md)

## 背景

用户诉求：「有 LSP 的情况下 agent 还是频繁 Grep，没充分利用 LSP」。实测（见基线文档）把问题定位到了与直觉相反的地方：

1. **agent 不是不知道 LSP**——插件装好 6 天内它用过 29 次。是**用了、失望、退回 Grep**。
2. **根因是冷启动窗口**：语言服务器由内置 LSP 工具**懒启动**（第一次调用才拉起），而 rust-analyzer 在这个仓库上要 **46–73 秒**建索引。窗口内 `findReferences` 返回**空数组而非错误**，agent 分不清「真的没有引用」和「还没索引好」。
3. **提示词治不了**（已量化）：注入系统提示把 LSP 调用从 0 抬到 4 次，但那 3 次引用查询 **100% 返回空**。hint2 的 agent 逐条照做了「先预热 → 查询 → 稍后重试」，两处坐标都对，仍全空——因为两次尝试都落在索引窗口内。「稍后重试」对模型不是可执行指令：它没有时钟，也拿不到「还没好」与「真的没有」的区别。
4. **LSP 只在名字有歧义时才碾压**：`LspManager::get` 的调用点，裸 grep `.get(` 有 **547** 处噪音，LSP 一次给出 **15** 条精确结果（已反向核对）；而接收者变量名 `mgr` 只能靠读代码得到。反例同样成立：`is_excluded` 这种名字独特的符号，Grep 1–2 次就做对，LSP 要等 72.8 秒。

**结论**：要修的不是「让 agent 多用 LSP」，而是**给 agent 一条带显式状态的就绪通道**，并把语言服务器的启动提到它需要之前。LSP 与 Grep 是互补的两条路，不是替代关系。

## 目标

- agent 获得一条**语义查询通道**，其「未就绪」与「查询成功但为空」**可区分**。
- 复用编辑器**已有的** `LspManager`，不新建第二套语言服务器实现（符合 CLAUDE.md「能力单一事实源」）。
- 语言服务器的启动**提前到 agent 需要之前**，把 46–73 秒移出关键路径。
- 工具只在**真正划算**的场景引导使用（名字歧义、需要接口实现/调用层级）。

## 非目标

- **不做「LSP 优先」的强制引导**。实测表明名字独特时 Grep 更划算；强制会让 agent 白等。
- 不新建独立语言服务器进程池、不改 LSP 协议层、不碰每语言 profile。
- 不做补全 / 格式化 / 重构 / 诊断。
- **不覆盖 headless**：那里没有 Rust LSP，工具如实返回不可用（见「降级」）。

## 架构

```text
agent
  → MCP tool（aide-lsp）
    → sidecar: emit {type:"lsp_query", request_id, ...}      [既有事件通道]
      → Rust runtime 拦截 → lsp/agent_bridge.rs 校验
        → LspManager（主进程内，**不跳 runner**）
      ← {cmd:"lsp_result", request_id, ...}                  [既有命令通道]
    ← sidecar 按 request_id 兑现 → 格式化为文本回模型
```

三个要点：

1. **与 codegraph 逐字同构**。`codegraph_query` 事件进、`codegraph_result` 命令出，合同在 `src-tauri/src/codegraph/agent_bridge.rs`，拦截点在 `src-tauri/src/runtime/mod.rs:277-330`。LSP 加一路并列分派，不发明新协议。
2. **查询不跳 runner**。codegraph 的查询本体要经 `CodeGraphService::agent_query` 转发给 runner；`LspManager` 就住在主进程，拦截点直接就地执行。这一跳省掉。
3. **单一事实源**。全仓仍只有一套 LSP 实现（`src-tauri/src/lsp/`）。agent 不再走 Claude Code 内置 LSP 工具，因此**不会再起第二个语言服务器进程**——内存不翻倍。

## 组件

| 位置 | 职责 |
|---|---|
| `src-tauri/src/lsp/agent_bridge.rs`（新） | 解析 `lsp_query`、构造 `lsp_result`。对账 `codegraph/agent_bridge.rs`，含「回包 cmd 标不得串」的测试 |
| `src-tauri/src/runtime/mod.rs` | 拦截点加一路分派（与 codegraph 并列，互不干扰） |
| `src-tauri/src/lsp/query.rs`（新） | 服务层：名字→坐标解析、就绪探测、把各命令的 `status` 归一成工具状态词 |
| `src-tauri/src/lsp/mod.rs` | 新增 `lsp_workspace_symbol` 命令（见下） |
| `agent-sidecar/src/extensions/lspTools.ts`（新） | MCP server 注册 + **四档挂载闸门** + 工具面 + 状态文案。对账 `codegraphTools.ts` |
| `agent-sidecar/src/extensions/lspClient.ts`（新） | request_id 桥 + 超时。对账 `codegraphClient.ts` |

### 新增命令：`lsp_workspace_symbol`

**编辑器目前没有这条**：它只暴露了 `lsp_document_symbol`（文件内符号），没有按名全局找符号——而 agent 的入口恰恰是名字。这是本设计唯一需要新增的 LSP 命令，形状与其他命令同构：

```
lsp_workspace_symbol(workspace_root, query, lang?) -> LspSymbolSearchResult { status, candidates: [{name, kind, file_path, line, column, lang}] }
```

**语言参数定案**：`lang` 可选。给了就只查该语言；缺省时对该工作区**已配置的全部语言**依次查询并合并，每条候选带上 `lang` 标明来源。理由：agent 只拿得到一个名字，没有扩展名可据以分派（`lang_from_ext_of` 在此不适用），逼它先猜语言等于把一个问题变成两个。合并查询的额外延迟由候选数上限兜住。

## 工具面（第一批）

| 工具 | 用途 | 底层 |
|---|---|---|
| `lsp_symbols(name)` | 按名找符号定义 | 新增的 `workspace/symbol` |
| `lsp_references(symbol)` | 谁引用了它 | `lsp_references` |
| `lsp_definition(symbol)` | 定义在哪 | `lsp_definition` |
| `lsp_implementations(symbol)` | 谁实现了这个接口/被它实现 | `lsp_implementation` |

统一入参形态，两种二选一：

- `{ file, line, character }` —— 调用方已知位置（从 Read 或 document_symbol 得到）
- `{ name, file? }` —— 只知名；服务层先用 `workspace/symbol`（可带 file 缩小范围）解析坐标，解析失败按 `no_symbol` 返回

四个工具的**输出 token 纪律**沿 codegraph 既有约束（`find_symbol ≤20 条`、单次结果目标 ≤2KB），超限截断并如实标注。

## 挂载闸门：按「有已配置的语言服务器」挂载

**问题**：MCP 工具的**定义**（名字 + 描述 + schema）每一轮请求都要重发。对一个没有语言服务器的用户，四个工具的 schema 是纯开销，还会诱导模型去调一个注定返回 `no_server` 的工具。

**方案**：沿用 `codegraph` 的既有范式，`lspToolsRegistration` 在不满足条件时**返回 `null`**——server 根本不挂载，工具对模型不存在。四档闸门（前三档都是现成的）：

| 闸门 | 来源 | 现状 |
|---|---|---|
| `trusted` | session-worker 参数 | 已有 |
| 工作区 LSP 开关 | `workspace_set_lsp_enabled` + 信任门 | 已有 |
| **该工作区至少一种语言有已配置的 server** | 新增：主进程算好下发 | 新增 |
| `AIDE_LSP_TOOLS=off` | env 逃生舱 | 新增（照 `AIDE_CODEGRAPH_TOOLS` / `AIDE_DOCX_TOOLS` 惯例） |

下发路径照抄 `codegraphEnabled`：Rust 侧 `is_codegraph_enabled_for_path(&cwd)` → `session-worker.startLoop(cwd, trusted, codegraphEnabled)` → `queryContext` deps。新增参数建议直接传**语言列表**而非布尔（`lspLanguages: string[]`），因为第三档闸门与之后的查询分派都用得上同一份信息。

**为什么不用「服务器真的起来了才挂」**：那需要在会话中途改工具列表 → 必须重建 query（`applyFlagSettings` 改不动工具集，仓库里 `thinking` 开关已实测过这条路），代价是一次上下文重算。静态闸门已经拿走了全部成本收益，不值得再付重建代价。

**副作用（正向）**：「降级」表里的 `no_server` 一档因此大幅收窄——没配 server 的工作区根本没有这些工具，不靠文案兜。但**该档仍需保留**：配置了却起不来（`spawn_failed` / `handshake_failed`）依然存在。

## 就绪判定（本设计的核心）

**问题**：现成的 `EnsureOutcome.ready` **不能直接用**。`src-tauri/src/lsp/mod.rs:114` 的注释写明：Java 索引期 `ready=false`，**其余为 true**——即 rust-analyzer 在 `ready=true` 的那一刻索引根本没建好（正是实测的 46–73 秒）。直接拿它当闸门会**重犯内置工具那个错误**（把「还没好」当「没有」）。

**方案：两段式**

1. `ensure_server` → `{ok, ready, kind}`。`ok=false` 直接定性：`server_not_found` / `untrusted` / `handshake_failed` / `spawn_failed`。
2. **就绪探测**：轮询一个廉价语义查询（对任一已存在文件做 `document_symbol`）直到返回非空，带预算上限（默认 90s）。探测结果按 server 缓存一次，避免每次查询重复付。

**对外的状态词**（工具返回的文本由它决定）：

| 状态 | 含义 |
|---|---|
| `ready` | 可服务，结果可信 |
| `indexing` | 进程在、索引未完成。**明确告知空结果不代表没有** |
| `no_server` | 该语言未配置 / 未安装 server |
| `untrusted` | 工作区未信任，拒拉 server（继承既有信任门） |
| `timeout` / `gone` | 查询未完成或 server 死亡，结果**未验证** |

**红线**：任何情况下**不得**用空数组冒充「没有引用」。要么 `ready` + 空（可信的"没有"），要么非 `ready` 状态 + 明确说明。

## 预热时机与代价

- **触发点**：**第一条用户消息之后**，不是会话启动。仅当 `lsp_detect_languages` 报告该工作区存在**已配置**的语言时才预热。
- **动作**：`ensure_server` + 后台就绪探测；失败静默（不影响对话，只让后续查询返回 `no_server`）。
- **代价明示**：会为深度探索的会话起一个语言服务器进程。rust-analyzer 在本仓库实测**常驻 5.0–5.3 GB**（稳定不涨）。不给空转会话白付这份内存是这个触发点的设计意图。

## 降级与错误处理

| 情形 | 工具返回 |
|---|---|
| headless / 无 Rust LSP 进程 | 显式文本「本部署无 LSP，改用 Grep」 |
| 工作区未信任 | 「工作区未信任，LSP 不可用」 |
| `no_server` | 「该语言未配置语言服务器；用 Grep 兜底」 |
| `indexing` | 「索引中（已 N 秒）。**空结果不代表没有引用**；稍后重试，或先用 Grep 并在结论里标注未验证」 |
| `timeout` / `gone` | 同上，明确标注结果未验证 |
| `candidates > 1`（同名多义） | 列出候选位置，**要求先 Read 消歧**，不假装唯一——照 codegraph 的 `candidates` 处理 |
| 任何失败路径 | **返回文本而非抛错**（沿 codegraph 约定） |

## 风险

1. **共用 `OpenDocs` 的串扰**（**C1 的前置条件**）。agent `didOpen` 的文件会进 `LspManager` 的 `OpenDocs`，与编辑器共用同一命名空间 → 那些文件的诊断/通知会流到编辑器 UI，用户会看到自己没打开过的文件报错。
   **定案：方案 ①**——给 agent 打开的文档打标，推送侧按标记过滤。理由：不动 `OpenDocs` 的结构（那是编辑器热路径），只在源头加一个来源字段。落地时先确认推送路径能拿到该标记；**拿不到就退到方案 ②**（独立命名空间），并在实现中记为偏离。
2. **名字→坐标的歧义**。`workspace/symbol` 返回候选列表，重载/同名多义时仍需模型判断；`candidates>1` 必须如实告知。
3. **协议新增帧的三端同步**。`lsp_query` 是**事件通道**帧，relay 对远程客户端**全量转发无过滤**（CLAUDE.md 红线）。远程/移动端的 agent 同样跑在用户桌面，所以语义正确；但需确认 PWA / ohos 对未知事件类型是**忽略**而非报错。
4. **内存**。复用单实例已是最优；但若编辑器从未打开过 LSP，agent 的预热会触发**首次 spawn**（本仓库 rust-analyzer 约 5GB）。这是为能力付的必要代价，不是泄漏。

## 测试

- **Rust 单测**：`agent_bridge` 的校验与构造（借 `codegraph/agent_bridge.rs` 的测试形态，含「回包 cmd 标不可串成 codegraph_result」这类）；就绪探测状态机（`ready`/`indexing`/`timeout` 迁移）；`lsp_workspace_symbol` 的多候选与空结果分支。
- **sidecar 单测**：工具面状态→文案映射（每种状态一条，重点断言**没有任何一条把空结果说成"没有引用"**）；request_id 配对与超时；headless 降级文本。
- **端到端验收**：复用 spike 的 `run-lsp-ab.sh` 加一个**名字有歧义**的任务（如 `LspManager::get` 的调用点）。判据：LSP 组给出 15/15 精确调用点，且调用次数不劣于 Grep 组。

## 分期

- **C1（先做）**：桥 + 就绪探测 + 预热 + `lsp_symbols` + `lsp_references`。以 spike 的歧义任务端到端验收。
- **C2**：`lsp_definition` + `lsp_implementations`；`call_hierarchy` 视使用情况再定。

## 未决问题

本节只留**真正需要实测/查证**的项；设计选择已在正文定案（语言参数见「新增命令」，`OpenDocs` 方案见「风险 1」，预热开关见下）。

1. **远程客户端对未知事件类型的行为**（风险 3）——需查 PWA / ohos 的事件分发是否有「未知类型静默忽略」的兜底。有则无需改动；没有则要给两端加兜底，否则 `lsp_query` 帧会让它们报错。
2. **`ready` 探测的预算与频率**：默认 90s 上界是拍的，实现时用真实仓库标定（本仓库 rust-analyzer 实测 46–73s，jdtls 更长）。

**已定案、不再作为开放项**：预热**不加显式开关**——按「该工作区已配置语言」自动判定（YAGNI）。用户要关掉时，既有的工作区 LSP 开关与信任门已经够用。
