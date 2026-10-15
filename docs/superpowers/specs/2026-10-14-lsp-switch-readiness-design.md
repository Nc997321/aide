# LSP 开关收口 · 分能力就绪 · 按意图顺带作答（设计）

日期：2026-10-14 · 状态：待实施

## 0. 起因与实测

- 真机截图：同一会话里 `lsp_outline` 先答上，紧接着 `lsp_definition {name:"StageInfo"}` 回「it is still indexing」。
  - 文案层的谎言已修（未提交）：Rust `unverified_outcome` 借用 `indexing` 状态、真实原因在 `error`，sidecar `reasonOf` 把 `error` 丢了。现在 `indexing`+`error` 交出真实原因，不带 `error` 才说 still indexing。
- 宿主机实测（jdtls 1.58，po-api，探针 `%LOCALAPPDATA%\Temp\aide-jdtls-probe\probe.mjs`）：
  - 启动到 `ServiceReady` 13.8s；**之后第一次 `workspace/symbol` 花了 24.9s**，后续每次约 0.1s。Aide 的按名查询总预算 `SYMBOL_SEARCH_TIMEOUT` = 20s → 首查必然落进「未确认」。这是截图最可能的真因。
  - 嵌套类按名精确命中（`containerName` = 外层类）——「StageInfo 是嵌套类」假设不成立。
  - 依赖 jar / JDK 的类按名、跳转定义都返回 `jdt://contents/...`；`java/classFileContents` 8ms 拿到 FernFlower 反编译文本。Aide 全仓不处理 `jdt://`（见 §7，不在本期）。
- 现状缺口（读代码确认）：
  1. **工作区 LSP 开关只管了一半**：`lsp_workspaces[key].enabled`（Host state，默认 false）只被前端编辑器认；Host `lsp_ensure_server` / `ensure_lang` 只看信任门，agent 会话开始无条件 `warm`（`session-worker.ts`）。用户在标题栏关了 LSP，开个会话照样拉起 server。
  2. **两套「就绪」**：标题栏认 jdtls `ServiceReady`（`lsp-server-ready` 事件）；agent 认 sidecar 的 `readyRoots`（预热探针通过）。界面亮「就绪」时 agent 可能还查不到（实测差 25s）。
  3. **顺带作答对用户不可见**：`lspGlance` 经 hook `additionalContext` 只进模型上下文，前端 / 手机无渲染。

## 1. 目标

1. 一个开关：「本工作区开不开语言服务器」，**关 = 不起进程**，由 Host 一处保证。
2. 会话启动前由代码判断是否需要询问用户；按工作区记住，不每次问。
3. 就绪按能力分开实测，Host 持唯一状态并广播；用户看得到进度与真实就绪。
4. 顺带作答按 grep 写法推断意图，意图明确时直接附定义体 / 引用列表；用户在对话里看得到附了什么。

非目标：`jdt://` 内容通道、Java 语言包、工具精简（§7）。

## 2. 开关：复用现有字段，Host 一处把关

### 2.1 数据

`WorkspaceLspConfig` 加一个字段：

```rust
pub struct WorkspaceLspConfig {
    #[serde(default)] pub enabled: bool,
    /// 用户对「开不开」做过选择（询问卡片 / 标题栏开关任一写入即置 true）。
    /// 旧记录没有该字段 → false：存量的 enabled=false 分不清「关过」还是「保存排除目录时顺带写的默认值」，一律按「没问过」处理。
    #[serde(default)] pub decided: bool,
    #[serde(default)] pub exclude_dirs: Vec<String>,
}
```

`workspace_set_lsp_enabled` 同时写 `decided = true`。存量 `enabled = true` 的工作区视同已决定（读取时 `decided || enabled`），不再询问。

### 2.2 Host 把关

`ensure_lang`（及其命令壳 `lsp_ensure_server`）在信任门之后加开关门：`!enabled` → 返回 `EnsureOutcome { ok:false, kind:"disabled" }`，**不 spawn**。`AgentLspStatus` 加 `Disabled`（`from_ensure` 映射）。所有入口——编辑器、agent 工具、顺带作答、预热——都经过这一处，sidecar 侧的检查只是省一次往返。

关闭时按序做三件事：① 取消该工作区**进行中的预热 future**（§4.3）——否则导入到一半被关、预热随后完成，会把状态写回 `ready`，sidecar 的 `readyRoots` 死灰复燃；② `lsp_shutdown_workspace` 停掉全部 server（现有行为）；③ 状态置 `off` 并广播（§4.4）。

**关闭 ≠ 休眠**：休眠（§4.5）开关仍开，用到即唤醒；关闭后开关为关，send 时的预热检查、编辑器打开文件、agent 工具调用都**不会**拉起 server（预热检查先看开关；漏网的请求在 `ensure_lang` 被拒为 `disabled`），直到用户自己重新打开。

### 2.3 开关变更广播

开关是会话可见状态（多端一致性红线）：`workspace_set_lsp_enabled` 成功后经事件总线发 `lsp-switch-changed { workspaceRoot, enabled }`。询问卡片、标题栏「语言环境」开关、手机写的都是这同一个字段，**任一处改了，其余处都跟着变**。消费者：

- 标题栏 `useWorkspaceLsp`：现在 `enabled` 只在切工作区时读一次、之后只认本面板点击——改为订阅该事件，`workspaceRoot` 等于窗口当前工作区时更新（会话工作区 ≠ 窗口工作区时标题栏不变，切过去时读到的就是新值）。
- 编辑器 `useLsp` 的 `isLspOn` 缓存：同样由该事件驱动（现在只在标题栏 enable/disable 时改），否则卡片开了而编辑器的跳转 / 悬停仍不接 LSP。
- 手机（Link 事件目录暂不收录，交付协议后由手机端自定）。sidecar 不订阅，见 §3.3。

## 3. 会话启动前询问

### 3.1 判定（代码，模型不参与）

会话 `send` 前（前端发起新会话 / 首条消息时），对**会话自持的工作区**（`wsPath`，同 send 的 cwd 解析，不是窗口当前活动工作区）调一个新命令 `lsp_session_preflight(workspaceRoot)`。语言探测复用 `lsp_languages_for_path`（`detector::detect_languages` 扫该目录 + `registry::resolve` 能否解析出 server），即现在 send 下发给 sidecar 的同一份——主窗口在 po-api（Java）时新开 aide 会话，探到的是 aide 的 Rust / TS：

| 情况 | 返回 | 前端 |
|---|---|---|
| 未信任 | `untrusted` | 不问 |
| `decided` | `decided{enabled}` | 不问，照做 |
| 探到的语言里没有任何 server 已装或可装（语言包目录有） | `nothing` | 不问 |
| 否则 | `ask{langs:[{lang, installed, packId?}]}` | 出询问提示 |

提示里不写内存量级（静态估计既不准也占地方，2026-10-15 去掉）；实际占用在「语言环境」面板实时显示（§4.5）。

### 3.2 询问时机与形态：新会话发出首条消息时，不阻塞

**只在「新会话（空白面板 / 待定会话）+ 工程模式 + 有工作区」点发送时判定**：打开 / 浏览已有会话不问，日常模式不问（日常目录不是工程）。演变（2026-10-15 真机反馈）：聊天区常驻卡片（点开任何会话都弹）→ 复用权限卡的发送前确认（欢迎页里整块横在页顶、输入框被收起，「很丑」）→ 现在这一版。

**不阻塞发送**：消息照发，输入框正上方、与输入框同宽出一条提示（`LspSendPrompt.vue`，`ChatInputBox` 的 `above-box` 插槽；判定与落实在 `lspSendGate.ts`）：

> 〔语言服务器〕检测到 **Java** 项目，要开启语言服务器吗？开启后 agent 能精确跳转定义、查找引用。　［不开启］［开启］×

- 「开启」：写开关（true）。**Host 打开开关即在后台起服务并预热**（`workspace_set_lsp_enabled` → `start_warm`），这一轮 agent 之后的 LSP 查询接上这次预热；顺带作答从下一条 send 起生效。要装语言包的显示「安装并开启」，后台装完再开，进度在「语言环境」面板，失败弹通知。
- 「不开启」：写开关（false，即已决定），以后不再问。
- 「×」或一直不理：不记录，下次新会话还问。点之前等同于没开：LSP 工具如实说「未开启」并给文本兜底。
- 询问**记在工作区上**（`lspSendGate.pendingLspAsk`），不挂在面板上：新会话拿到正式 id 时面板的会话号 / 工作区路径写法会变、面板可能重建，挂在面板上会一闪就没（真机反馈）。同一工作区的工程模式面板都显示，直到选了、点了 ×、或别处（其他会话 / 客户端）已替它选了（`lsp-switch-changed`）。内存量级按文案合并（TS / JS 同一个语言服务器不写两遍）。

### 3.3 sidecar 行为

- **aide-lsp 工具一直挂载**：`lspGate.ts` 三条判据（信任 / 有语言 / `AIDE_LSP_TOOLS`）不变，用户开关**不进闸门**。内置 `*-lsp` 插件照旧退役（替代品在场），关闭时它们也不会偷起 server。成本约 1.0–1.3k token/轮，命中缓存。
- **预热**：`session-worker.ts` 的 `warm` 从「每会话一次」（`lspWarmed`）改为**每条 send 检查**（`lspClient.syncLspWarmth`，在 `handleSend` 入口——`startLoop` 只在建 query 时跑，同一 query 的后续消息不经过它）：Host 随 send 下发 `lsp_enabled`；开着且该根未就绪、无进行中的预热 → 发 `warm`（单飞）；关着 → 作废就绪记录。覆盖会话开始、中途打开开关（下一条 send 生效）、空闲休眠后再次使用（§4.5）。sidecar **不订阅** `lsp-switch-changed`：Host 不必另开一条往 sidecar 推事件的通道；会话中途被关时，任何查询回 `disabled` 也会作废就绪记录。
- **工具调用遇 `disabled`**：`LspNav` 走文本兜底（`text_search` 不需要 server），文案注明「本工作区未开启语言服务器，以下为纯文本出现处（UNVERIFIED）」，新增 `lspFormat` 分支，**不说 still indexing、不说没有**。
- **顺带作答**：`isWarm()` 门不变；关闭时 `readyRoots` 永不写入，hook 首行返回。

不使用 `setMcpServers`：工具列表在会话内恒定，提示缓存不因开关失效。

## 4. 分能力就绪：Host 持唯一状态

### 4.1 状态机（每个 工作区 × 语言）

```
off / sleeping ─开启或唤醒→ starting ─握手成功→ loading（工程导入）─→ indexing ─┬→ ready
                                                              └→ failed{reason}
任意态 ─关闭→ off；─空闲→ sleeping；─异常退出→ failed
```

`ready` 拆成两个能力位，都靠**实测**置位，不信 server 自报：

- `nav`：现有 `probe_ready`（对代表文件的跳转探测）通过。
- `symbols`：用代表文件 outline 里第一个类/函数名发 `workspace/symbol`，**精确命中**才算通过。语言无关；server 未声明 `workspaceSymbolProvider` 的（如 Volar）该位标 `unsupported`。

server 自报信号只做**进度展示与阶段推进**，不做判据：jdtls `language/status` 的百分比与消息（实测 `Starting 50% … Project 'po-api'`）、标准 `$/progress`（rust-analyzer）。不报的 server（typescript-language-server）只显示阶段 + 已等待秒数。

### 4.2 预热吸收冷启动

`warm_all` 每种语言：拉起 → 递代表文件 → 探 `nav` → 探 `symbols`（预算沿用 `WARM_PROBE_BUDGET` 120s）。实测的 25s 首查在会话开头、用户打字和模型思考期间被吸收。

### 4.3 查询接到进行中的预热上

按名查询（`lookup_symbol`）若该语言 `symbols` 位未置，**等待同一个进行中的预热 future**（在本次查询预算内），而不是另发一条注定超时的请求。

- 等到 → 正常查询。
- 没等到 → `indexing`，`error` 写实「符号索引仍在建立（已等待 N s）」——这时说「索引中」是真话。

预热按 (workspace, lang) 单飞（`StatusBoard::begin_warm`，`Core.lsp_board`，不放进 `LspState` 的写锁里）。**查询只接上进行中的探测，不新开**：探测一直没过时若每发查询都新开一轮，会各自等满预算。谁开探测：sidecar 预热、编辑器拉起 server（`lsp_ensure_server` / `lsp_did_open`）——后者保证只用编辑器的用户状态板也会走到就绪。

### 4.4 广播与消费

Host 状态变化经事件总线发 `lsp-status { workspaceRoot, lang, phase, nav, symbols, progress?, message?, since }`（`aide_core::bus`，可回放，手机按订阅收）。

- 标题栏 `useLspStatus`：改为订阅它；删除基于 `lsp-server-ready` 的 ok 切换与 90s 慢计时器（被 `since` 取代）。
- sidecar `readyRoots`：仍以 `warm` 的结果为准（sidecar 不订阅 Host 事件，见 §3.3），但 `warm` 现在接到 Host 的单飞探测上（`agent_query::start_warm`），结果与状态板同源；关闭 / 停机时 Host 取消探测，sidecar 下一条 send 或任一查询回 `disabled` 即作废。
- `lsp-server-ready` 事件保留到前端迁移完成后删除。

### 4.5 空闲休眠（已实施：`lsp/idle.rs`）

**判据在 server 侧，与会话解耦。** server 实例本来就按 (workspace, lang) 唯一（`LspManager::get`），同工作区的多个会话与编辑器共用同一个 jdtls。每个实例记 `last_used`，以下任一刷新它：agent 查询、顺带作答、预热、编辑器请求（定义 / 悬停 / 补全…）、`didOpen` / `didChange`。

- 休眠条件：`now - last_used ≥ 30min`（设置 `lsp.idleSleepMinutes`，0 = 永不）**且**编辑器里没有打开该语言的文档（打开着的标签意味着用户随时会跳转）。不看会话数：关掉一个会话不影响另一个仍在使用的会话；会话开着但 30 分钟没有任何 LSP 请求，照样休眠。
- 休眠 = 停进程，状态进 `sleeping`（与用户关闭的 `off` 区分，标题栏显示「已休眠」），**开关不变**，`readyRoots` 随 `lsp-status` 清除（顺带作答不去敲已停的 server）。
- 巡检：每 Host 一个后台任务（第一台 server 拉起时启动），每 30s 一轮；判定是纯函数 `idle::judge`。
- sidecar 收不到 Host 事件：就绪记录带时间，超过 `REWARM_AFTER_MS`（5 分钟）的下一条 send 再预热一次确认（仍就绪是快路径），休眠后的冷启动由此挪进模型思考期。
- 唤醒：下一条 send 触发预热（§3.3）；预热完成前到达的工具查询接到进行中的预热上（§4.3），预算内没等到 → 如实回「语言服务器重新启动中，已等待 N s」+ 文本兜底，不静默失效。编辑器打开该语言文件同样唤醒。

- **实际内存占用**：巡检每轮顺带用 `sysinfo` 采样每台 server **进程树**的内存（Windows 工作集 / Linux RSS；要算子孙：PATH 上的 `javapath\java.exe` 是转发壳，JVM 在子进程），进 `lsp-status` 的 `memory`，变化 >16MB 且 >5% 才重发；「语言环境」面板每行显示「就绪 · 1.2 GB」。真机 po-api：启动 337MB → 就绪 1.2GB。
- **标题栏倒计时**：`lsp-status` 带 `sleepAt`（预计休眠的时间戳；编辑器有打开文档时为 `null` 并带 `keptBy:"editor"`）。前端拿时间戳本地每秒算「32 分钟后休眠」/「编辑器打开着 Java 文件 · 不休眠」，Host 不按秒推。`last_used` 刷新很频繁，`sleepAt` 只在比上次广播的值移动超过 30s 时才重发（倒计时误差 ≤ 30s）。

放在第二阶段：依赖 §4.4 的统一状态才安全。

## 5. 顺带作答：按意图附加

### 5.1 意图推断（只看 grep 写法）

| 模式（Grep `pattern` 或 Bash 里 grep/rg 的模式） | 意图 | 附加 |
|---|---|---|
| 声明关键字 + 名字：`fn X`、`class X`、`interface X`、`struct X`、`enum X`、`def X`、`function X`、`const X =`、`X =`（行首）等，关键字表随语言扩 | 找定义 | 定义体，≤ 40 行（超出给 `Read offset/limit` 提示） |
| 名字 + 调用 / 成员访问：`X\(`、`X(`、`\.X\b`、`::X` | 找用法 | 引用列表：每处 `file:line [所在函数] 行文本`，≤ 15 条（超出给总数 + `lsp_references` 提示） |
| 裸名字 | 不确定 | 现有一行摘要（位置、行区间、引用数） |

- 每次 grep 仍最多 3 个名字；全量附加只给意图明确的那一个名字，其余降为一行摘要。
- 预算不变（`GLANCE_BUDGET_MS`），超时退回摘要；未命中仍记负缓存（`MAX_MISSES`）。**未命中必须廉价**这条红线不动。
- 定义体与引用渲染复用 `LspNav` 现有实现（`definition` / `references` 的格式化），不另写一份。

### 5.2 对用户可见

hook 产出结构化附注（与给模型的文本同源，`lspGlance.ts` 的 `glanceOne` 一次产出两份）：

```ts
type LspGlanceItem =
  | { kind: "summary"; name; defs: Array<{ file; line; kind; endLine? }>; refCount?; refFiles?; ambiguous? }
  | { kind: "definition"; name; file; line; symbolKind; endLine? }
  | { kind: "references"; name; total; shown: Array<{ file; line; enclosing }> };
```

- sidecar 生成 `additionalContext` 的同时**广播** chat-event `lsp_glance { tool_use_id, items }`（事件通道，桌面 / 手机都从这里拿，不在前端本地拼）。类型在 `agent-sidecar/src/engine/types.ts` 与 `packages/aide-sdk/src/types/chat.ts` 各一份，`lspGlanceParity.test.ts` 逐字对账。
- SDK 事件处理把 items 挂到对应工具块的 `lspGlance` 上；hook 跑在工具执行后、结果交模型前，事件可能先于或后于 `tool_result`，两种顺序都认。
- 桌面：`LspGlanceNote.vue`，Grep / Bash 行下方一枚药丸「LSP 补充 · 2 个符号 · 附函数体」，点开中文列出定义区间 / 引用数 / 所在函数，路径可点（`openResolved`）。
- 回放：总线留底，断线重连能补上。**从磁盘重开的历史会话没有这份结构**：转录里只有给模型的英文文本（`hook_additional_context` 附件，带 `toolUseID`），要补得从文本反解，暂不做。
- 手机：协议照交付，渲染由手机端自定（项目约定）。
- 回放：事件按会话留底，重开会话仍能看到。

## 6. 落地顺序

| 阶段 | 内容 | 主要文件 |
|---|---|---|
| P1 | 开关收口：`decided` 字段、`ensure_lang` 开关门、`Disabled` 状态、sidecar 预热改条件、`disabled` 文本兜底文案、`lsp-switch-changed` | `commands/workspace/mod.rs`、`lsp/mod.rs`、`agent_status.rs`、`session-worker.ts`、`lspNav.ts`、`lspFormat.ts` |
| P2 | 会话前询问：`lsp_session_preflight`、询问卡片 | 新命令、`ChatPanel` 附近新组件、`api/` 门面 |
| P3 | 分能力就绪：状态机、`symbols` 探针、预热单飞 + 查询等待、`lsp-status` 广播；标题栏与 `readyRoots` 改订阅 | `agent_query.rs`、`agent_readiness.rs`、`manager.rs`、`useLspStatus.ts`、`lspClient.ts` |
| P4 | 顺带作答按意图附加 + `lsp_glance` 事件 + 对话内标记 | `lspGlance.ts`、SDK `types/chat.ts`、`ChatMessage` / `ToolCallBlock` |
| P5（可选） | 空闲自动关闭 | `manager.rs` |

P1 独立可发（修掉「关了照样起」）；P3 是 P4 的前提（`readyRoots` 换源）；P2 依赖 P1。

## 7. 本期不做，记账

- **`jdt://` 内容通道**：公共层只认「结果不是磁盘文件 → 向 profile 要内容」，Java 在 `profiles/java.rs` 用 `java/classFileContents` 实现；agent 结果直接带源码 / 反编译片段并标来源，编辑器开只读窗口。实测 8ms，可行。
- **Java 语言包**（`packs/catalog.rs` 目前只有 typescript / python / rust）：版本必须钉死并声明最低 JDK——jdtls 最新快照要求 **Java 25**（Java 21 上 1.7s 退出、OSGi 报 `osgi.ee=JavaSE 25`），1.58.0 要求 Java 17；安装前检测 JDK；下载要断点续传、可配镜像（官方站国内直连约 12 KB/s 且会断，USTC 只镜像 milestones）。
- **`downloadSources` 未生效**：实测拿到的是反编译而非源码 jar，待查。
- **工具精简**：P4 上线后按工作机真实数据决定是否把 `lsp_symbols` / `lsp_outline` 合并或去掉。

## 8. 测试

- Rust：`ensure_lang` 开关门（关 → `disabled` 且未 spawn）；预热进行中关闭 → 预热被取消、状态停在 `off` 不回 `ready`；`decided` 读写与旧记录兼容；`symbols` 探针精确匹配；查询等待预热 future（预热先完成 / 预算先到两种）；`lsp-status` 阶段序列。
- sidecar：`disabled` → 文本兜底文案（不含 still indexing / No …）；开关打开后补发预热且只一次；意图推断表（每类正反例，含 Bash 里的 `rg`/`grep -n`）；全量附加截断；`lsp_glance` 事件与 `additionalContext` 同源。
- Rust（P5）：两个会话共用一个 server 实例；关掉其中一个会话不影响 `last_used`；有打开的文档不休眠；休眠后查询触发唤醒并等待。
- 前端：会话卡片「开启」后标题栏开关与编辑器 LSP 同步打开（同工作区），会话工作区不同时标题栏不变；标题栏关闭后其他客户端同步；询问卡片三种出口；同工作区两个会话 / 多客户端一端选择后另一端卡片消失；会话工作区与窗口活动工作区不同时按会话工作区探测；标题栏按 `lsp-status` 渲染进度；Grep 行下标记展开 / 路径点击。
- 真机回归：po-api（Java）与 aide 仓库（TS + Rust）各跑一遍：首查不再落「未确认」、标题栏就绪与 agent 能查到一致、关闭后 `tasklist` 无 java / rust-analyzer 进程。
