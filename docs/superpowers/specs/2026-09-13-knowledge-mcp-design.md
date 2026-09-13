# 知识库读写内置插件设计（aide-knowledge MCP）

- 日期：2026-09-13
- 状态：设计定稿，等 spec 审阅后进实施计划
- 关联：`knowledge-server/README.md`（REST 契约）；CLAUDE.md「agent-sidecar 职责边界（extensions 层）」；CLAUDE.md「可替换技术藏在端口后面」（知识库是独立服务，本插件只做客户端，不把检索逻辑搬进 sidecar）
- 关联记忆：`aide-codegraph-agent-tools-adoption`（**instructions 是必需品**，不是优化）；`aide-cost-saving-levers`（恒挂工具的基座成本）

## 1. 背景与目标

`knowledge-server/`（独立 HTTP 二进制 `aide-knowledge`，默认 `127.0.0.1:8788`，Bearer 鉴权，PG 全文检索 + jieba 分词）目前**唯一的消费者是桌面前端**（`src/components/KnowledgeBase/kbClient.ts` 裸 fetch 直连）。agent 侧零代码：sidecar 与 `src-tauri/` 里 grep `knowledge` 零命中。结果：用户跟 agent 说「把刚才的结论存进知识库」，agent 既看不到也写不了。

**目标**：给 agent 一个内置 MCP 插件（`aide-knowledge`），让它在**用户明确提及知识库**时能查、能写。不做自动检索注入、不做自动归档——那些是后续迭代。

## 2. 范围

**做**：读 4 工具（search / read_document / list_spaces / list_documents）+ 写 4 工具（create_document / append_document / update_document / ingest_file），凭据经凭据文件（名称随档位，见 §6.1）到 sidecar，工具**每次调用现读**该文件。

**不做（v1 明确排除）**：自动检索把片段注入上下文；会话结束自动归档；知识库自维护（改名/标签/合并/去重）；`knowledge` SKILL.md；向量检索（知识库侧本来就没有）；删除文档（知识库无此接口）；标签与双链（表已建、接口未做）。

## 3. 凭据通道：为什么是「文件 + 调用时现读」（方案 A）

三条候选，已定案 A：

| 方案 | 凭据路径 | 新鲜度 | 否决理由 |
|---|---|---|---|
| **A（定案）** | 前端推 → Rust 写凭据文件（名称随档位，见 §6.1） → 工具**每次调用**读文件 | 调用级 | — |
| B | 前端推 → Rust 每条 `send` 塞 `cmd["kb"]` → MCP 闭包持值 | 会话级 | 会话中途重新登录后，工具整会话拿死 token；错误路径无法自愈 |
| C | 工具 emit → Rust 代发 HTTP | 调用级 | 要照搬 codegraphClient 的超时/pending/取消整套 IPC（~150 行 + Rust HTTP 客户端），对"最简单的读写"过重 |

两条硬约束逼出 A：

1. **凭据不能进 env**（`agent-sidecar/src/engine/sessionMetadata.ts:1-14` 红线）：Bash 工具子进程继承 env，模型跑 `env` 即可外带凭据。A 的 env 里只有**路径**（`AIDE_KB_CONFIG_FILE`），token 本体走文件。
2. **`mcp_headers` 通道用不上**：`applyMcpHeaders`（`sessionMetadata.ts:62-82`）只对 `type:"http"|"sse"` 注入，进程内 `type:"sdk"` server 被显式跳过；且桌面侧本来就没有 `mcp_headers` 写入点（只有 headless 网关发）。

附带收获：调用时现读让**未登录时也能挂载并返回引导文本**，模型能如实告诉用户缺什么，而不是"没有工具可用"。

## 4. 工具面（8 个）

### 4.1 读（4 个，自动放行）

| 工具 | 后端 | 输入 | 行为 |
|---|---|---|---|
| `search` | `GET /api/search` | `query`（必填）、`spaceId?`、`limit?`（默认 20，服务端 clamp 1..100） | 返回命中清单：title / documentId / spaceId / versionNo / 摘要。摘要**剥掉 `[[HL]]` 哨兵**保留纯文本（避免把服务端标记混进后续写入的正文） |
| `read_document` | `GET /api/documents/{id}` | `documentId` | 全文 + versionNo + title；超 `KB_READ_MAX_CHARS` 截断并显式注明「已截断」 |
| `list_spaces` | `GET /api/spaces` | 无 | 可见空间（id / key / name / visibility / role） |
| `list_documents` | `GET /api/spaces/{id}/documents` | `spaceId` | 该空间文档扁平树（id / parentId / title / versionNo / updatedAt） |

### 4.2 写（4 个，走权限弹窗，**不进放行白名单**）

| 工具 | 后端 | 输入 | 行为 |
|---|---|---|---|
| `create_document` | `POST /api/documents` | `spaceId`、`title`、`content`、`parentId?` | 新建文档。slug 由服务端生成 |
| `append_document` | `GET` → `PUT` | `documentId`、`content`、`changeNote?` | **读当前正文 → 末尾追加 → 写回**。指令里定为首选沉淀方式 |
| `update_document` | `PUT /api/documents/{id}` | `documentId`、`content`、`title?`、`changeNote?` | 整篇替换 |
| `ingest_file` | `POST /api/ingest` | `filePath`（磁盘路径）、`spaceId`、`parentId?` | multipart 上传 md/txt/docx/pdf，服务端解析成 markdown。相对路径按会话 cwd 解析（沿 `buildDocxTools(cwd)` 先例），绝对路径直接用 |

**为什么写工具要「先 GET 再 PUT」**：知识库的 PUT 只接受 `{title, content, changeNote}`，**没有 versionNo 参数**——并发保护只有 300s 同作者合并窗口（`knowledge-server/src/domain/versioning.rs:27-123`）与文档行锁。追加必须在工具内部先读后拼，否则并发下静默覆盖。

**读回来的正文必须是串**：形态漂移（服务端换版本 / 中间代理）时若照 `?? ""` 拼，写回的就只剩新段落 = 静默删掉别人的正文。P2 落地为**显式守卫**：非串 → 返回失败文本、**不写**（与 P1 删掉 `?? ""` 防御臂同一条理由，附录 B 记过）。

**空间不猜**（写工具共用的解析规则）：`spaceId` 可省略 → 可见空间**唯一**则用它；**多个** → 返回文本列出候选空间，让模型回头问用户。绝不默认往第一个空间写——那是共享资源。

**常量**（实现轮可调，先给值）：

| 常量 | 值 | 用途 |
|---|---|---|
| `KB_CONTENT_MAX_BYTES` | 256 KiB | **单次调用传入的 `content` 参数**上限（append 只算新增段落），超限返回引导文本 |
| `KB_DOC_MAX_BYTES` | 1 MiB | **写回后的整篇正文**上限。P2 落地只挂在 append：replace 的正文就是整篇，已被单次闸 256 KiB 蕴含（真加进去是一条走不到的分支，实现轮取严删去）——这道闸真正拦的是 append 的**累积** |
| `KB_READ_MAX_CHARS` | 100 000 | `read_document` 输出上限 |
| `KB_INGEST_MAX_BYTES` | 32 MiB | 导入文件上限。**服务端必须同步**：`knowledge-server` 的 `INGEST_BODY_LIMIT`（只挂 `/api/ingest` 一条路由，不全局放宽），且必须**严格大于**本值——客户端量的是文件、服务端量的是整个 multipart 体，两者差着分帧开销；取等号时恰好 32 MiB 的文件会在客户端放行、被服务端拒成一句看不出原因的 400。那层不显式设的话是 axum 的 2 MiB（`Multipart` 的 `with_limited_body()`） |
| `KB_HTTP_TIMEOUT_MS` | 15 000 | 读 / 写请求超时 |
| `KB_INGEST_TIMEOUT_MS` | 120 000 | 导入请求超时（上传 + 服务端解析） |

## 5. 挂载门控与降级

### 5.1 门控（**恒挂**，除三道既有门）

| 门 | 条件 | 效果 |
|---|---|---|
| operator env | `AIDE_KB_TOOLS=off` | 返回 `null`，不注册 |
| 受限模式 | `!trusted` | 返回 `null` |
| btw 任务支线 | `taskTools` 非空 | 跳过注册（前缀最小化，沿 docsMcp） |

**不设「配置了才挂」的门**（已定案）：知识库未配置 / 未登录时**照样挂载**，调用返回引导文本。理由：① 工具列表跨会话稳定；② 会话中途第一次登录知识库能当场生效，不必开新会话；③ 「未登录」这个事实有地方表达。代价：不用知识库的用户每会话多背 ~8 个工具 schema（约 1k token，进 prompt cache）。headless 部署可用 `AIDE_KB_TOOLS=off` 关掉。

轻量 btw 支线**不跳过**（与主会话保持逐字节一致的前缀，2026-08-09 实锤）；门控判据只有 `taskTools` 非空，沿 `queryContext.ts:61-63` 的 docs 写法。

### 5.2 降级语义（红线）

**失败一律返回文本，永不 throw、永不 `isError`**（沿 codegraph/docs 红线：「工具报错会让 agent 纠结，文本提示让它自然换路」，`codegraphTools.ts:50`）。

| 情形 | 给模型看的文本要点 |
|---|---|
| 凭据文件缺失 / 坏 JSON | 「知识库未连接。让用户在『知识库』面板登录后重试」 |
| 401 | 「登录已失效。让用户重新登录后重试」（不提示"开新会话"——A 方案下次调用就生效） |
| 403 | 「当前账号对该空间/文档没有权限」 |
| 404 | 「文档不存在，可能已被删除或 id 有误；可用 search / list_documents 重新定位」 |
| 409（他人持锁） | 「文档正被 X 编辑，稍后重试」 |
| 网络失败 / 超时 | 带 baseUrl 的提示 + 「确认知识库服务是否在运行」 |
| 超限 / 空结果 | 各自的引导文本 |

**凭据永不进日志 / 错误消息**（沿 `sessionMetadata.ts` 的 N5 纪律）：错误文本只描述形状，不带 token。

## 6. 接线

### 6.1 凭据文件协议

路径：**按构建档位分名**——dev（debug 构建）= `~/.aide/knowledge.dev.json`，release = `~/.aide/knowledge.json`（`our_config_dir()` 下，**独立文件**，不混进 `state.json`——生命周期与并发面隔离：登出即删，不必挤进 state 的 load-modify-save 临界区，一次凭据轮换也不值得触发一次全量状态落盘）。

为什么分名：localStorage 按 WebView **origin** 分区（dev 前端来自 `build.devUrl` 的 `http://localhost:1420`，release 来自 Tauri 自己的源），两档各持一份凭据。共用同一文件时，后写的一档会覆盖另一档——表现为「面板显示未登录、agent 却能读写知识库」（另一档写的文件还在），或「release 的 agent 以 dev 那次登录的账号身份读写」（换账号时）。代价是两档各持一份，**dev 里需要单独登录一次**（dev 首次推送即自建 `knowledge.dev.json`；已有 release 凭据不受影响，release 侧行为不变）。

```json
{ "version": 1, "baseUrl": "http://127.0.0.1:8788", "token": "<bearer>" }
```

- 写入：临时文件 + rename 原子替换；登出 = 删文件。
- 读取：**fail-closed**——文件缺失 / JSON 坏 / `baseUrl` 为空 / `token` 为空 / `version` 不认识 → 视为未配置，走引导文本，不抛。
- 落盘风险交底：token 明文落盘。它本来就在 WebView localStorage 里明文躺着（`kbClient.ts:13` `TOKEN_KEY = "aide.kb.token"`），风险等价；换来的是"重登自愈"。

### 6.2 前端推送（桌面专属）

localStorage 是唯一真相源（`getBaseUrl()` / `getToken()`）。推送时机：

1. **应用启动推一次**（`src/main.ts` 引导序列，fire-and-forget 不阻塞挂载）——覆盖「上次登录过、本次没开过面板」。**不推 agent 就永远拿不到凭据**，这条不能省。
2. 登录 / 建管理员 / 接受邀请成功后（`kbClient.ts:254,260,266` 三个 `setToken` 点）。
3. 登出后（推 `token: null` → 删文件）。
4. 登录页改服务地址后（`KbLogin.vue` 的 `onBaseBlur`）。

门面：`api.setKnowledgeRuntimeConfig({ baseUrl, token })` 收进 `packages/aide-sdk/src/api.ts`（禁止散 invoke）。**不进 remote REGISTRY**——没有远程调用方（REGISTRY 只白名单入站 invoke，桌面走 TauriTransport 直接到命令）。

### 6.3 Rust

| 项 | 内容 |
|---|---|
| 新命令 | `knowledge_set_runtime_config(base_url: String, token: Option<String>)` → 原子写 / 删凭据文件（名称随档位，见 §6.1）；返回 `Result<(), String>` |
| 同步还是 async | 轻 IO（一个几百字节文件）→ **保持同步 + 首行埋 `crate::diagnostics::trace_command("knowledge_set_runtime_config")`**（构建期守卫 `pnpm check:sync-io` 会扫所有做 IO 的同步命令） |
| 新增 env | spawn sidecar 时注入 `AIDE_KB_CONFIG_FILE`（绝对路径）。**只有路径，不是凭据** |
| 失败 | 写文件失败返回 Err 给前端（前端 best-effort 忽略，不阻塞登录） |

### 6.4 sidecar 文件层次

```
extensions/knowledgeMcp.ts        # 注册器：三道门 + createSdkMcpServer 组装（对齐 docsMcp.ts 的形状）
extensions/knowledgeTools.ts      # 一个工具一个 buildXxxTool + ≤10 行编排主函数 buildKnowledgeTools(env)（P1 落 4 个读工具，P2 补到 8 个）
extensions/knowledge/config.ts    # 凭据文件读取 + 校验（fail-closed）
extensions/knowledge/client.ts    # REST 薄客户端（fetch 可注入，便于单测；超时在此）
extensions/knowledge/format.ts    # 纯函数格式化器：失败原因 → 引导文本（单测主力）
```

`buildKnowledgeTools` 是**目录骨架**：只做「把各 builder 的返回值组成数组」（P1 4 个 builders），每个 builder 单独成形、各自 ≤40 行（用户结构约定）。签名落地为 **`buildKnowledgeTools(env)`**（P1），P2 计划按 `buildKnowledgeTools(env, cwd)` 落地（`ingest_file` 的相对路径要按会话 cwd 解析，`cwd` 走第二参）——**没有 ctx 对象**：凭据由 `kbCall` 每次调用现读 `env`（`readKbConfig(env)`），不进闭包持值（闭包值随 `query()` spawn 冻结，重登不自愈，见 §3）。

`textResult()` helper 与 `codegraphTools.ts:127` 形状相同：**本插件自带一份（3 行），不为此做跨文件重构**。

### 6.5 装配三处（漏一处即失效）

| 位置 | 改动 |
|---|---|
| `engine/session-worker/queryContext.ts:93` | `assembleMcpServers({...codegraphMcp, ...docsMcp, ...knowledgeMcp}, userMcp)` |
| `engine/session-worker/queryOptions.ts:73` | `allowedTools` 加四条**读**工具规则（见 §7） |
| `packages/aide-sdk/src/composables/useCustomizations.ts` | `builtinMcpServers` 加实际登记的那一行（`useCustomizations.ts:77`，P1 文案）：`{ id: "aide-knowledge", transport: "in-process", purpose: "内置知识库读写（search / read_document / list_spaces / list_documents，写工具见 P2），受信任工作区挂载；未登录时工具返回登录引导" }`——**没有动态事件，纯静态镜像，漏登记永久不可见**；P2 落地时回填四个写工具名。 |

### 6.6 instructions（必需品）

没有 instructions 块时模型对工具视而不见（2026-07-26 headless 冒烟实锤，`codegraphTools.ts:13-23`）。英文祈使句，草案：

```
The aide-knowledge tools read and write the user's team knowledge base (知识库).

RULES:
1. USE ONLY ON EXPLICIT REQUEST. Use these tools only when the user explicitly mentions the
   knowledge base. Never search or write proactively, and never write during an automated run
   unless the user asked for it.
2. NEVER GUESS A SPACE. Call list_spaces first. If more than one space is visible and the user
   did not say which, ask the user — writes land somewhere other people can see.
3. READ BEFORE YOU WRITE. Call read_document first and keep the parts you are not changing.
   Prefer append_document over update_document.
4. INGEST takes a file path on disk (md/txt/docx/pdf) — use it instead of pasting a large file
   into create_document.
5. FAILURES COME BACK AS TEXT with the next step. If a tool reports the knowledge base is not
   connected or the login expired, tell the user to sign in from the 知识库 panel and retry.
   Do not silently write the content to a local file instead.
```

以 `KNOWLEDGE_INSTRUCTIONS` 常量导出（`smoke-mcp.ts` 直接 import 同一份，防文案漂移）。

## 7. 权限模型：放行规则必须是**工具级**

`CODEGRAPH_ALLOW_RULE = "mcp__aide-codegraph"`（`codegraphTools.ts:11`）是 **server 级**——照抄会把写类工具一起放行，破坏「写必弹窗」。因此本插件导出**四条工具级常量**：

```ts
export const KNOWLEDGE_READ_RULES = [
  "mcp__aide-knowledge__search",
  "mcp__aide-knowledge__read_document",
  "mcp__aide-knowledge__list_spaces",
  "mcp__aide-knowledge__list_documents",
] as const;
```

写类四项**不进白名单**，走既有 `canUseTool` → 权限弹窗。

已知代价：弹窗展示原始工具参数，大正文（256 KiB 上限内）的弹窗会比较长。v1 不优化，记为后续项（可在弹窗层对长文本做折叠）。

## 8. 验收

| 层 | 测什么 | 位置 |
|---|---|---|
| 门控矩阵 | `AIDE_KB_TOOLS=off` / `!trusted` / `taskTools` 非空 → `null`；正常 → `spec["aide-knowledge"]` 存在 | `knowledgeMcp.test.ts` |
| 放行常量 | 四条常量值**逐字**断言（防漂移，尤其防被写成 server 级 `mcp__aide-knowledge`） | 同上 |
| 凭据读取 | 缺失 / 坏 JSON / 空 token / 未知 version → 未配置（不抛）；正常 → 读出 baseUrl+token | `knowledge/config.test.ts` |
| 格式化器 | 每个失败原因一条（未配置/401/403/404/409/网络/超时/超限/空结果），断言**返回文本而非 throw** 且含引导关键词 | `knowledge/format.test.ts` |
| HTTP 层 | 注入假 fetch：200 / 401 / 409 / 超时 / 畸形 JSON / 空 body | `knowledge/client.test.ts` |
| 空间解析 | 0 个空间 / 1 个 / 多个 三条分支（多 → 返回候选文本而非猜） | `knowledgeTools.test.ts` |
| 工具行为 | 追加 = 读到的正文 + 新段落（断言 PUT body 含旧正文）；超限被挡 | 同上 |
| snapshot | 工具描述 + instructions 全量快照，并显式 `expect(json).toContain("mcp__aide-knowledge")` 与 instructions 关键句（防 instructions 静默消失） | `__snapshots__/` |
| 集成 | `session-worker.test.ts` 断言 `captured.mcpServers["aide-knowledge"]` 存在 + `allowedTools` 含四条读规则且**不含**写规则 | `engine/session-worker.test.ts` |
| 冒烟 | `smoke-mcp.ts` 加一段真模型 MUST-call（无凭据则打印 SKIP 并继续） | `agent-sidecar/smoke-mcp.ts` |

⚠️ 当前工作区已有 `codegraphTools.test.ts.snap` / `docxTools.test.ts.snap` 两处改动，写 snapshot 测试时确认 diff 只含本轮新增。

每条带分支的函数在实现轮出**分支对账表**（分支 | 覆盖 | 测试名），带值路径优先；不可达臂注释标注（用户结构约定 §四）。

## 9. 已知代价与风险

1. **token 明文落盘**（`~/.aide/knowledge.json`，dev 档为 `~/.aide/knowledge.dev.json`，见 §6.1）：与 localStorage 现存风险等价；硬约束是永不进日志/错误消息。
2. **恒挂 ~8 个工具 schema**：不用知识库的用户也背 ~1k token 基座（进 prompt cache，约 10% 计费）；换取"中途登录即生效 + 可表达未登录"。
3. **知识库服务不由本应用 spawn**：它是独立部署的（docker compose / 手工 `cargo run`）。服务没起 → 工具返回网络引导文本，不是崩溃。
4. **代理**：sidecar 的 fetch 不自动走 HTTP_PROXY。知识库在 LAN/localhost 时无影响；远端部署 + 企业代理的组合留给后续（前端 kbClient 同样是裸 fetch，两边行为一致）。
5. **无乐观锁**：知识库 PUT 没有 versionNo，并发写入靠 300s 合并窗口兜底。追加工具内先读后拼已是最优，但仍非严格 CAS。
6. **多端**：remote-pwa / 鸿蒙驱动同一个桌面 sidecar，工具自动可用，无需改动；headless 无凭据文件 → 恒挂 + 引导文本。网关将来要打通得**两步**，少一步仍读不到：① 把凭据写进凭据文件（名称随档位，见 §6.1）；② 自己设 `AIDE_KB_CONFIG_FILE` 指向该文件——headless **不经过** `spawn_runtime`，而这个 env 只在 `spawn_runtime` 里注入（`runtime/mod.rs`），只写文件的话 `readKbConfig` 拿不到路径，工具照旧回「未连接」。兜底备选：让 `config.ts` 在没有 env 时回落默认路径（凭据文件，名称随档位，见 §6.1，headless 运维自己选名字即可）。
7. **写工具弹窗的长度边界**（P2 兑现 §7 那条代价）：弹窗展示的是**模型传进来的参数**——`create_document` / `update_document` 会把 ≤256 KiB 的正文整个铺开；`append_document` 只显示新增段落（整篇正文是工具内部 GET 回来拼的，不进弹窗）；`ingest_file` 只有路径。即长度由「模型给的正文」决定，不由「最终写回的正文」决定。
8. **投影响不到非桌面端**：写工具的多跳 GET→PUT 全在 sidecar 内部完成，remote-pwa / 鸿蒙走的仍是同一条 `send` 通道；权限弹窗由桌面端 `canUseTool` 出（§7），远端 UI 不在本期内。
9. **长文档整篇替换的残余风险（警告不阻断）**：`read_document` 在 `KB_READ_MAX_CHARS`(100k 字符) 处截断，原文更长时模型手里没有尾部——照「先读、把不改的部分搬过去」改写会丢内容。`update_document` 的处置是**写入照旧 + 回执里点明**（`warnTruncatedSource`：报出旧文长度、点明尾部可能已丢、指向版本历史），不做拒绝——拒绝会挡掉「用户自己给了全文、就是要整篇重写」的正常场景。

## 10. 实施分期（供 writing-plans 参考）

两期，各自独立可验收：

| 期 | 内容 | 验收 |
|---|---|---|
| **P1 读通路** | Rust 命令 + `AIDE_KB_CONFIG_FILE` + 前端四处推送 + `knowledge/{config,client,format}.ts` + 4 读工具 + 三道门 + 工具级读放行规则 + 装配三处 + 镜像登记 | 会话里让 agent 搜到并读出知识库内容；未登录时返回引导文本 |
| **P2 写通路** | 4 写工具 + 空间解析 + 追加的先读后拼 + 超限挡板 + 权限弹窗实测 | 能新建 / 追加 / 更新 / 导入文件；写操作**必弹窗**、读操作不弹 |

P1 落地后知识库才能真正被 agent 用起来；P2 是先有读的闭环再开写。

## 附录 A：知识库 REST 速查（本插件用到的）

| 端点 | 方法 | 鉴权 | 备注 |
|---|---|---|---|
| `/api/spaces` | GET | Bearer | private 空间非成员不可见 |
| `/api/spaces/{id}/documents` | GET | Bearer | 扁平树，按可读文档集过滤 |
| `/api/documents` | POST | Bearer | `{spaceId, parentId?, title, content?}` → `{documentId, revisionId, versionNo, merged}` |
| `/api/documents/{id}` | GET | Bearer | `{id, spaceId, parentId?, slug, title, content, versionNo, status}` |
| `/api/documents/{id}` | PUT | Bearer | `{title, content, changeNote?}`；他人持锁 → 409 |
| `/api/search` | GET | Bearer | `?q=&spaceId=&limit=` → `{query, hits:[{documentId, spaceId, title, versionNo, rank, snippet}]}`；snippet 含 `[[HL]]` 哨兵 |
| `/api/ingest` | POST | Bearer | multipart（**只取第一个 field**），`?spaceId=&parentId=` → `{documentId, revisionId, title, backend, warnings}` |
| `/api/health` | GET | 无 | `{status, service, parsers, tokenizer}`（排障用） |

错误体统一 `{error: <code>, message: <中文>}`；DTO 一律 camelCase。

## 附录 B：分支覆盖对账表（P1 实现轮实测；P2 段见文末）

图例：✅ = 有用例触达该臂（执行到但未专门断言的标「未断言」）；⬜ = 可达但无用例；⛔ = 不可达（附理由）。
测试名列写实存用例名 `文件 > describe > it`；`it.each` 的行按 vitest 渲染值书写（`{ kind: 'unauthorized' } 的文案含关键指引与下一步`）。
模板行里的 `resolveSpaceId` 属 P2（本期未实现，见 §4.2 与 §10），`formatKbError` / `kbFetch` 是设计期的临时命名，落地名分别是 `formatFailure` / `raw`+`finish`——三者按落地名重列。

### knowledge/config.ts

| 函数 | 分支 | 覆盖 | 测试名 |
|---|---|---|---|
| `parseKbConfig` | `JSON.parse` 抛（坏 JSON）→ null | ✅ | config.test.ts > parseKbConfig > JSON 坏 → null（不抛） |
| | 非对象（数组 / 字符串 / `null`）→ null | ✅ | config.test.ts > parseKbConfig > 非对象（数组/字符串/null）→ null |
| | `version !== 1` → null | ✅ | config.test.ts > parseKbConfig > version 不认识 → null（fail-closed，给将来演进留门） |
| | `baseUrl` 非串或空 → null | ✅ | config.test.ts > parseKbConfig > baseUrl 缺失或空 → null |
| | `token` 非串或空 → null | ✅ | config.test.ts > parseKbConfig > token 缺失或空 → null |
| | 带值路径：正常形状 → 配置 | ✅ | config.test.ts > parseKbConfig > 正常形状 → 配置，尾斜杠被剥掉 |
| | 带值路径：尾斜杠剥离（`replace(/\/+$/, "")` 命中）| ✅ | config.test.ts > parseKbConfig > 正常形状 → 配置，尾斜杠被剥掉 |
| | 带值路径：无尾斜杠（replace 无匹配）| ✅（未断言，经 readKbConfig 透传触达） | config.test.ts > readKbConfig > 正常文件 → 配置 |
| `readKbConfig` | env 无 `AIDE_KB_CONFIG_FILE` → null | ✅ | config.test.ts > readKbConfig > env 没给路径 → null（不是错误：说明这台机器没登录过知识库） |
| | `readFileSync` 抛（文件不存在 / 权限）→ null | ✅ | config.test.ts > readKbConfig > 路径指向不存在的文件 → null |
| | 读到了但内容坏 → 透传 `parseKbConfig` 的 null | ⬜ | —（可达：文件存在但 JSON 坏；parseKbConfig 已单测，这一层无用例） |
| | 带值路径：读出 `{baseUrl, token}` | ✅ | config.test.ts > readKbConfig > 正常文件 → 配置 |

### knowledge/client.ts

| 函数 | 分支 | 覆盖 | 测试名 |
|---|---|---|---|
| `safeEncode` | `encodeURIComponent` 成功（普通串 / 合法代理对）| ✅ | client.test.ts > docPath > 孤立代理项不抛（模型能传进来）→ 替换字符；合法代理对原样编码（emoji 臂） |
| | 抛 URIError → 替换 U+FFFD 再编码 | ✅ | client.test.ts > withQuery > 孤立代理项不抛（模型能传进来）→ 替换字符（键、值两条路径）；client.test.ts > docPath > 孤立代理项不抛…；knowledgeTools.test.ts > list_documents 的 spaceId 编码兜底 > 孤立代理项不抛，落到 U+FFFD 再编码 |
| `withQuery` | `query` 省略（undefined）→ 原路径 | ✅ | client.test.ts > withQuery > 没有有效键时保持原路径（不冒出一个 ?） |
| | `query` 给了但全被跳过（`parts` 空）→ 原路径 | ✅ | client.test.ts > withQuery > 没有有效键时保持原路径（不冒出一个 ?）（`{}` 那半条） |
| | 值为 `undefined` 的键跳过 | ✅ | client.test.ts > withQuery > 拼查询串，undefined 的键跳过 |
| | 带值路径：`?k=v&…` | ✅ | client.test.ts > withQuery > 拼查询串，undefined 的键跳过；client.test.ts > createKbClient > sendFile 走 multipart，字段名 file（工具层 URL 断言亦覆盖） |
| | 键 / 值都走 `safeEncode` | ✅ | client.test.ts > withQuery > 孤立代理项不抛（模型能传进来）→ 替换字符（键、值两条路径） |
| `docPath` | 带值路径：正常 id 原样 | ✅ | client.test.ts > docPath > uuid 原样进路径；knowledgeTools.test.ts > read_document > 取全文并做 URL 编码（id 不会拼出额外路径段） |
| | 含 `/` 的 id 被编码 | ✅ | client.test.ts > docPath > 带斜杠的 id 被编码（裸拼会多出一段路径） |
| | 孤立代理项 / 合法代理对 | ✅ | client.test.ts > docPath > 孤立代理项不抛（模型能传进来）→ 替换字符；合法代理对原样编码 |
| `spaceDocsPath` | 带值路径：正常 id 原样 | ✅ | client.test.ts > spaceDocsPath > uuid 原样进路径；knowledgeTools.test.ts > list_spaces / list_documents > list_documents 打空间文档树 |
| | 含 `/` 的 id 被编码 | ✅ | client.test.ts > spaceDocsPath > 带斜杠的 id 被编码（裸拼会多出一段路径） |
| | 孤立代理项 / 合法代理对 | ✅ | client.test.ts > spaceDocsPath > 孤立代理项不抛（模型能传进来）→ 替换字符；合法代理对原样编码；knowledgeTools.test.ts > list_documents 的 spaceId 编码兜底 > 孤立代理项不抛，落到 U+FFFD 再编码 / 合法代理对（emoji）不被改写 |
| `extractMessage` | 合法 JSON 且 `message` 非空串 → 用服务端 message | ✅ | client.test.ts > createKbClient > 409 → locked，并带上服务端 message |
| | 合法 JSON 但非对象 / `message` 缺失或非串 → 截断原文 | ✅（未断言回退值本身） | client.test.ts > toFailure > 403 → forbidden；未知 4xx → bad_request 且带服务端 message（`"{}"` 那半条） |
| | `JSON.parse` 抛 → 截断原文 | ✅ | client.test.ts > toFailure > 错误体不是 JSON → message 退回截断原文（不抛） |
| | 截断到 200 字符 | ✅ | 同上（`f.message.length === 200`） |
| `toFailure` | 401 → `unauthorized` | ✅ | client.test.ts > createKbClient > 401 → unauthorized（401 不当作通用 bad_request） |
| | 403 → `forbidden` | ✅ | client.test.ts > toFailure > 403 → forbidden；未知 4xx → bad_request 且带服务端 message |
| | 404 → `not_found` | ✅（经工具层，client 层无直测） | knowledgeTools.test.ts > read_document > 404 → 引导回 search |
| | 409 → `locked` + 服务端 message | ✅ | client.test.ts > createKbClient > 409 → locked，并带上服务端 message |
| | ≥500 → `server` + status | ✅ | client.test.ts > createKbClient > 500 → server，带状态码 |
| | 其余状态码 → `bad_request` | ✅ | client.test.ts > toFailure > 403 → forbidden；未知 4xx → bad_request 且带服务端 message（422 那半条） |
| `raw`（`makeRaw` 闭包） | 拿到响应 → `{ok:true,status,text}` | ✅ | client.test.ts > createKbClient > GET 成功 → data；带 Bearer 头与 Accept |
| | `ctl.signal.aborted` → `timeout` | ✅ | client.test.ts > createKbClient > 超时 → timeout（用假定时器把 15s 推快） |
| | 非 abort 抛错 → `network` + baseUrl + detail | ✅ | client.test.ts > createKbClient > fetch 抛错 → network，带 baseUrl 与原始信息（不带 token）；client.test.ts > createKbClient > 垃圾 baseUrl（面板自由文本可产生）→ network 文本失败，不抛 |
| | 抛的**不是** `Error` → `String(e)` 臂 | ⬜ | —（可达但无用例：fetch 实现抛非 Error 时） |
| | `body` 是 string → 补 `Content-Type: application/json` | ✅ | client.test.ts > createKbClient > POST 带 JSON body 与 Content-Type |
| | `body` 非 string（GET / FormData）→ 不补 Content-Type | ✅（未断言缺席） | client.test.ts > createKbClient > GET 成功 → data；带 Bearer 头与 Accept |
| | `body === undefined` → 不设 body | ✅（未断言缺席） | client.test.ts > createKbClient > GET 成功 → data；带 Bearer 头与 Accept |
| | `finally` 清掉超时定时器（成功 / 失败两侧）| ✅（行为断言：成功路径后假定时器无悬挂；无独立用例） | client.test.ts > createKbClient > 超时 → timeout（用假定时器把 15s 推快） |
| `finish` | `!r.ok` → 透传 failure | ✅ | client.test.ts > createKbClient > fetch 抛错 → network…；client.test.ts > createKbClient > 超时 → timeout… |
| | 非 2xx → `toFailure` | ✅ | client.test.ts > createKbClient > 401 → unauthorized… |
| | 2xx + JSON 可解析 → `{ok:true,data}` | ✅ | client.test.ts > createKbClient > GET 成功 → data；带 Bearer 头与 Accept |
| | 2xx + JSON 抛 → `bad_response` | ✅ | client.test.ts > createKbClient > 2xx 但 body 不是 JSON → bad_response |
| `createKbClient` | `getJson` = `withQuery` + `KB_HTTP_TIMEOUT_MS` | ✅ | client.test.ts > createKbClient > 超时 → timeout（用假定时器把 15s 推快）（15s 即该常量）；client.test.ts > withQuery > 拼查询串，undefined 的键跳过 |
| | `sendJson` = `JSON.stringify` + 方法透传（POST / PUT）| ✅ | client.test.ts > createKbClient > POST 带 JSON body 与 Content-Type（POST 臂）；client.test.ts > createKbClient > 409 → locked，并带上服务端 message（PUT 臂） |
| | `sendFile` = FormData + `KB_INGEST_TIMEOUT_MS` | ✅ | client.test.ts > createKbClient > sendFile 走 multipart，字段名 file |
| | `fetchImpl` 缺省 = 全局 `fetch` | ✅ | client.test.ts > createKbClient > 垃圾 baseUrl（面板自由文本可产生）→ network 文本失败，不抛（未传第二参） |
| | `fetchImpl` 注入臂 | ✅ | client.test.ts > createKbClient > GET 成功 → data；带 Bearer 头与 Accept（其余 createKbClient 用例同理） |

### knowledge/format.ts

| 函数 | 分支 | 覆盖 | 测试名 |
|---|---|---|---|
| `stripHighlight` | 含 `[[HL]]` / `[[/HL]]` → 剥掉、文字保留 | ✅ | format.test.ts > stripHighlight > 剥掉 [[HL]] / [[/HL]] 哨兵，保留文字 |
| | 无哨兵（`replaceAll` 无匹配） | ⬜ | —（可达：服务端未产生高亮时 snippet 不带哨兵） |
| `formatFailure` | `unauthorized` 臂（含「不需要开新会话」） | ✅ | format.test.ts > formatFailure（每条失败原因都给下一步，永不抛）> { kind: 'unauthorized' } 的文案含关键指引与下一步；同 describe > unauthorized 明确说不需要开新会话（现读凭据，重登即生效） |
| | `forbidden` 臂 | ✅ | format.test.ts > formatFailure（…）> { kind: 'forbidden' } 的文案含关键指引与下一步 |
| | `not_found` 臂 | ✅ | format.test.ts > formatFailure（…）> { kind: 'not_found' } 的文案含关键指引与下一步 |
| | `locked` 臂（回显 message） | ✅ | format.test.ts > formatFailure（…）> { kind: 'locked', message: '被占用' } 的文案含关键指引与下一步 |
| | `bad_request` 臂（回显 message） | ✅ | format.test.ts > formatFailure（…）> { kind: 'bad_request', message: '标题不能为空' } 的文案含关键指引与下一步 |
| | `server` 臂（回显 status） | ✅ | format.test.ts > formatFailure（…）> { kind: 'server', status: 502 } 的文案含关键指引与下一步 |
| | `network` 臂（回显 baseUrl，不漏 token） | ✅ | format.test.ts > formatFailure（…）> { kind: 'network', baseUrl: 'http://kb:8788', detail: 'ECONNREFUSED' } 的文案含关键指引与下一步；同 describe > network 文案带 baseUrl 但不含 token |
| | `timeout` 臂 | ✅ | format.test.ts > formatFailure（…）> { kind: 'timeout' } 的文案含关键指引与下一步 |
| | `bad_response` 臂 | ✅ | format.test.ts > formatFailure（…）> { kind: 'bad_response', detail: 'not JSON' } 的文案含关键指引与下一步 |
| | switch 穷尽性（漏一臂 → TS `never`）| ✅（类型层，无用例） | — |
| `formatSearchHits` | `hits` 缺失（undefined）→ `hits.length` 抛 → `kbCall` 的 catch 兜成 `bad_response` 文本 | ⬜ | —（可达：服务端 200 不返回 hits；本条**不是函数内的分支**，而是缺字段时的**抛出路径**（该函数本身对这两个字段不再设防御臂）。`?? []` 防御臂已删——它会把「形状不符」静默变成「零命中」；catch 臂由 knowledgeTools.test.ts > 200 但响应形状不对（畸形 2xx）> list_spaces / list_documents 两条覆盖） |
| | 零命中 → 换关键词指引 | ✅ | format.test.ts > formatSearchHits > 零命中给换关键词的指引（不是错误） |
| | 带值路径：行列表（title / documentId / space / 版本 + 剥哨兵 snippet）| ✅ | format.test.ts > formatSearchHits > 命中列表带 documentId / 空间 / 摘要；knowledgeTools.test.ts > search > 拼 q / spaceId / limit，返回命中 |
| `formatDocument` | `content` 缺失（undefined）→ `body.length` 抛 → `kbCall` 的 catch 兜成 `bad_response` 文本 | ⬜ | —（可达：DTO 契约要求必填；本条**不是函数内的分支**，而是缺字段时的**抛出路径**（该函数本身对这两个字段不再设防御臂）。`?? ""` 防御臂已删——空正文在 P2 的 append（读当前正文 → 拼接 → 写回）里等于丢内容；catch 臂同上两条覆盖） |
| | 超限 → 截断 + ⚠ 注明 | ✅ | format.test.ts > formatDocument > 超长截断并注明（不静默丢内容） |
| | 带值路径：未超限 → 全文 | ✅ | format.test.ts > formatDocument > 带标题 / id / 版本号 / 正文；knowledgeTools.test.ts > read_document > 取全文并做 URL 编码（id 不会拼出额外路径段） |
| `formatSpaces` | 空数组 → 检查成员资格指引 | ✅ | format.test.ts > formatSpaces / formatDocumentList > 零空间时给出检查成员资格的指引 |
| | 有空间 + `role` 在 → 追加「your role」 | ✅ | format.test.ts > formatSpaces / formatDocumentList > 空间列表带 id 与名称 |
| | 有空间 + `role` 缺席 → 省略 role 段 | ✅（未断言省略） | knowledgeTools.test.ts > list_spaces / list_documents > list_spaces 打 /api/spaces 并渲染空间（用例数据无 role 字段） |
| `formatDocumentList` | 空数组 → 「no documents」（不点名不存在的工具）| ✅ | format.test.ts > formatSpaces / formatDocumentList > 文档列表带 id / 版本 / 更新时间；空列表不提到不存在的工具 |
| | `parentId` 空（null / undefined）→ 省略 `(under …)` | ✅（未断言省略） | 同上（用例数据 `parentId: null`） |
| | `parentId` 在 → 追加 `(under …)` | ⬜ | —（可达：子文档；用例只给了 null） |
| | 带值路径：行列表（title / id / vN / updatedAt）| ✅ | 同上 |

### knowledgeTools.ts / knowledgeMcp.ts

| 函数 | 分支 | 覆盖 | 测试名 |
|---|---|---|---|
| `kbCall` | `readKbConfig` 为 null → 未连接引导文本（不发请求）| ✅ | knowledgeTools.test.ts > 未配置凭据（恒挂的降级路径）> 任何工具都返回「未连接 + 去登录」，且不发请求 |
| | 带值路径：`r.ok` → `onOk(data)` | ✅ | knowledgeTools.test.ts > search > 拼 q / spaceId / limit，返回命中（余三工具的 happy 用例同） |
| | `!r.ok` → `formatFailure(r.failure)` | ✅ | knowledgeTools.test.ts > search > 401 → 引导重新登录（不是抛错）；knowledgeTools.test.ts > search > 网络失败 → 带 baseUrl 的文本；knowledgeTools.test.ts > read_document > 404 → 引导回 search |
| | `run` / 格式化器抛 → `bad_response` 文本（永不 reject）| ✅ | knowledgeTools.test.ts > 200 但响应形状不对（畸形 2xx）> list_spaces：resolves（不是 rejects），降级成 bad_response 文本；同 describe > list_documents：resolves（不是 rejects），降级成 bad_response 文本 |
| | `createKbClient(cfg)` 走缺省 fetch（工具层不注入）| ✅ | 工具层全部用例（`vi.stubGlobal("fetch", …)` 顶掉的正是默认参数） |
| `buildSearchTool` | 只给 `query`（`spaceId`/`limit` 省略）| ✅ | knowledgeTools.test.ts > search > 401 → 引导重新登录（不是抛错） |
| | 三个入参都给 → URL 拼全 | ✅ | knowledgeTools.test.ts > search > 拼 q / spaceId / limit，返回命中 |
| `buildReadDocumentTool` | `documentId` → `docPath` 编码 | ✅ | knowledgeTools.test.ts > read_document > 取全文并做 URL 编码（id 不会拼出额外路径段） |
| | 404 失败路径 | ✅ | knowledgeTools.test.ts > read_document > 404 → 引导回 search |
| `buildListSpacesTool` | 无参 → `/api/spaces` | ✅ | knowledgeTools.test.ts > list_spaces / list_documents > list_spaces 打 /api/spaces 并渲染空间 |
| | 畸形 2xx 降级 | ✅ | knowledgeTools.test.ts > 200 但响应形状不对（畸形 2xx）> list_spaces：resolves（不是 rejects），降级成 bad_response 文本 |
| `buildListDocumentsTool` | `spaceId` → `spaceDocsPath` 编码 | ✅ | knowledgeTools.test.ts > list_spaces / list_documents > list_documents 打空间文档树 |
| | 孤立代理项 spaceId 不抛 | ✅ | knowledgeTools.test.ts > list_documents 的 spaceId 编码兜底 > 孤立代理项不抛，落到 U+FFFD 再编码 |
| | 合法代理对 / emoji 不被改写 | ✅ | knowledgeTools.test.ts > list_documents 的 spaceId 编码兜底 > 合法代理对（emoji）不被改写 |
| | 畸形 2xx 降级 | ✅ | knowledgeTools.test.ts > 200 但响应形状不对（畸形 2xx）> list_documents：resolves（不是 rejects），降级成 bad_response 文本 |
| `buildKnowledgeTools` | 只暴露 4 个读工具（名字与顺序）| ✅ | knowledgeTools.test.ts > buildKnowledgeTools > P1 只暴露 4 个读工具 |
| `knowledgeMcpRegistration` | 门 1：`!trusted` → null | ✅ | knowledgeMcp.test.ts > knowledgeMcpRegistration — 门控矩阵 > !trusted → null（受限模式不暴露知识库读写）；同 describe > trusted 优先于 env（两道门并列，任一不满足即 null） |
| | 门 2：`taskTools` 真值 → null | ✅ | knowledgeMcp.test.ts > knowledgeMcpRegistration — 门控矩阵 > btw 任务支线（taskTools 非空）→ null（前缀最小化） |
| | 门 2 的 `taskTools === []`（真值判定把空数组也拦下）| ⛔ | 不可达：上游 session-worker.ts:579 只在 `cmd.tools?.length` 时写 `this.taskTools`，空数组不会传下来（与 codegraph/docs 两处 `deps.taskTools ? …` 同约定） |
| | 门 3：`AIDE_KB_TOOLS === "off"` → null | ✅ | knowledgeMcp.test.ts > knowledgeMcpRegistration — 门控矩阵 > AIDE_KB_TOOLS=off → null |
| | 带值路径：三道门全通 → `{"aide-knowledge": server}` | ✅ | knowledgeMcp.test.ts > knowledgeMcpRegistration — 门控矩阵 > 默认注册（缺省 trusted=true、无 taskTools）；knowledgeMcp.test.ts > instructions 是 MCP 采纳率的必需品 > 工具描述快照 + instructions 关键句（防静默消失） |
| | 装配落位（三处少汇一处即静默失效）| ✅ | session-worker.test.ts > SessionWorker — codegraph MCP registration > lightweight btw keeps full mcpServers / skills / plugins (cache prefix parity) |
| | `KNOWLEDGE_READ_RULES` 工具级、逐字（非 server 级、无写工具）| ✅ | knowledgeMcp.test.ts > 放行规则是**工具级**的（server 级会连写工具一起放行）> 四条常量逐字固定 / 没有任何一条等于 server 前缀（防漂移成 mcp__aide-knowledge）；session-worker.test.ts > SessionWorker — knowledge MCP 放行规则（工具级）> knowledge 写工具不在 allowedTools（写必弹窗） |

---

## 附录 B（续）：P2 写通路实现轮对账表

图例同上。**P2 四个文件为实测 100% 分支覆盖**（`vitest --coverage --provider=v8`，
2026-09-13 跑，非静态对账）：`knowledgeTools.ts` 22/22、`knowledge/format.ts` 29/29、
`knowledge/operations.ts` 40/40、`knowledge/space.ts` 8/8；该轮 focused 7 files / 121 passed，
全量 agent-sidecar 62 files / 911 passed、仓库根 202 files / 2479 passed。

### knowledge/space.ts（新增，纯函数）

| 分支 | 覆盖 | 测试名 |
|---|---|---|
| `requested` 真值（非空串）→ 直接用 | ✅ | space.test.ts > decideSpace > 显式传了 spaceId → 直接用（不校验存在性，服务端会 403/404） |
| `requested` 假值（undefined / 空串）→ 进可见性判定 | ✅ | 同 describe > 省略 + 恰好一个可见空间 → 用它；同 describe > 空串 spaceId 视同省略（模型可能传 ""） |
| 可见空间**唯一** → 自动选 | ✅ | 同 describe > 省略 + 恰好一个可见空间 → 用它 |
| 零个 → 「去查成员资格」文本 | ✅ | 同 describe > 省略 + 零个可见空间 → 让模型去查成员资格（不是「随便挑一个」） |
| 多个 → 列候选 + 「Ask the user」（含 `name`/`id` 插值） | ✅ | 同 describe > 省略 + 多个可见空间 → 列出候选并让模型问用户，绝不自动挑 |

### knowledge/format.ts（P2 增补）

| 分支 | 覆盖 | 测试名 |
|---|---|---|
| `humanBytes` 的 `>= 1 MiB` 真臂（MiB 档） | ✅ | format.test.ts > 写侧文案与尺寸常量 > formatTooLarge 在 MiB 档不显示成 1024 KiB |
| `humanBytes` 的 KiB 档 | ✅ | 同 describe > formatTooLarge 说清超了什么、上限多少、下一步怎么办 |
| `formatSavedDocument` 的 `merged` 真 / 假臂 | ✅ | 同 describe > formatSavedDocument 带动词、documentId 与版本号；合并窗口单独提示（一条用例压两臂） |
| `formatIngestResult` 的 `warnings?.length` 真臂 | ✅ | 同 describe > formatIngestResult 带标题/documentId/parser；有 warnings 时如实列出 |
| 同上的假臂与 `?.` 短路（warnings 缺失） | ✅ | 同上（`base` 那半条，未给 warnings） |
| 三个尺寸常量的值 | ✅ | 同 describe > 尺寸常量就是设计定的三个数（不是拍脑袋的近似值） |
| `formatDocumentList` 的 `parentId` 真值臂（P1 遗留 ⬜，本期补） | ✅ | format.test.ts > formatSpaces / formatDocumentList > 子文档带 parentId 时追加 (under …)（列表里能看出层级） |
| `warnTruncatedSource` 的 `<= KB_READ_MAX_CHARS` 真臂（不警告） | ✅ | format.test.ts > 写侧文案与尺寸常量 > warnTruncatedSource：旧文没超读上限 → 空串（不乱吓人） |
| 同上的假臂（警告：报长度 + 点尾部 + 指版本历史） | ✅ | 同 describe > warnTruncatedSource：旧文超读上限 → 说清尾部可能已丢 + 给出回滚路径 |

### knowledge/operations.ts（新增）

| 函数 | 分支 | 覆盖 | 测试名 |
|---|---|---|---|
| `withinLimit` | ≤ 上限 / > 上限 | ✅ | 见下各 operation 的超限与正常用例（create 256 KiB / update 256 KiB / append 1 MiB 三条超限 + 全部成功路径） |
| `resolveWriteTarget` | `requested` 真值 → 不拉列表 | ✅ | operations.test.ts > resolveWriteTarget > 传了 spaceId → 不再拉空间列表（少一次请求） |
| | 省略 + 拉到列表 → 交给 `decideSpace` | ✅ | 同 describe > 省略 → 拉 /api/spaces 交给决策：唯一空间自动选 |
| | 省略 + 拉列表失败 → 文本（不抛） | ✅ | 同 describe > 省略 + 拉列表失败 → 失败文本（不是异常） |
| `createDocument` | 超单次闸 → 早退，不发请求 | ✅ | createDocument > content 超 256 KiB → 拒绝且不发请求 |
| | `parentId` 真 / 假臂 | ✅ | 同 describe > 有 parentId 才带 parentId（不塞 null 字段）；POST 用例（不带 parentId） |
| | `saved.ok` 真臂 | ✅ | 同 describe > POST /api/documents…成功回执带 documentId |
| | `saved.ok` 假臂 | ✅ | 同 describe > 服务端 403 → 权限引导文本 |
| `updateDocument` | 超单次闸 → 早退（GET 都不发） | ✅ | updateDocument > 新正文超 256 KiB → 拒绝，GET 都不发（尺寸闸在读之前） |
| | 读失败 → 文本，不写 | ✅ | 同 describe > 读失败（404）→ 直接返回失败文本，不尝试写 |
| | `args.title ?? cur.title` 真 / 假臂 | ✅ | 同 describe > 显式 title 覆盖当前标题；先 GET 再 PUT…title 沿用当前版本 |
| | `changeNote` 真 / 假臂 | ✅ | knowledgeTools.test.ts > 写工具 > update_document：先 GET 再 PUT，title/changeNote 给了就带上；同 describe > 省略 title/changeNote → 沿用当前标题、不带 changeNote |
| | `saved.ok` 真 / 假臂 | ✅ | 同 describe > 先 GET 再用新正文 PUT…；同 describe > 409（他人持锁）→ 带服务端 message 的重试引导 |
| | 旧文长度 > `KB_READ_MAX_CHARS` → 回执加警告（**不阻断**） | ✅ | 同 describe > 旧文比 read_document 能展示的还长 → 照常写，但回执点明尾部可能已丢 |
| | 旧文非串 → 跳过警告、照常写（警告不该阻断已批准的替换） | ✅ | 同 describe > 旧文形状不对（非串）→ 照常写、不误报表头警告 |
| `appendToDocument` | 单次段落超 256 KiB → 拒绝，读也不发 | ✅ | appendToDocument > 单次追加段落超 256 KiB → 拒绝，GET 都不发（与 create / update 同一条闸） |
| | 读失败 → 文本，不 PUT | ✅ | appendToDocument > 读失败（404）→ 直接返回失败文本，不发 PUT |
| | 读回的正文非串（形态漂移守卫）→ 不写 | ✅ | 同 describe > 读回的正文不是串（形态漂移）→ 拒绝写回，不发 PUT |
| | 超整篇闸 → 拒绝，不 PUT | ✅ | 同 describe > 追加后整篇超 1 MiB → 拒绝且不发 PUT（单次上限挡不住累积） |
| | `changeNote` 真 / 假臂 | ✅ | 同 describe > changeNote 有才带（写进版本历史）；PUT body 必须含旧正文（不带） |
| | `saved.ok` 真 / 假臂 | ✅ | 同 describe > PUT body 必须含旧正文…；同 describe > 写回被拒（403）→ 透出权限引导，绝不谎报成功 |
| `ingestFile` | `isAbsolute` 真 / 假臂 | ✅ | ingestFile > 绝对路径直接用；同 describe > 相对路径按会话 cwd 解析，multipart 文件名取 basename |
| | `statSync` 抛 → 「File not found」 | ✅ | 同 describe > 文件不存在 → 说明相对路径规则，不发请求 |
| | `!st.isFile()` → 「Not a file」 | ✅ | 同 describe > 路径是目录 → 明确说不是文件，不发请求 |
| | 尺寸超 32 MiB → 拒绝（读之前） | ✅ | 同 describe > 超过 32 MiB → 拒绝且不读文件、不发请求 |
| | `readFileSync` 抛 Error → 报原始原因 | ✅ | 同 describe > stat 过但 read 抛（EACCES）→ 报出原始原因，不发请求 |
| | 抛的**不是** Error → `String(e)` 臂 | ✅ | 同 describe > 抛的不是 Error → 也要有话说（String(e) 臂，不吞错） |
| | `r.ok` 真臂 | ✅ | 同 describe > 相对路径按会话 cwd 解析…（Imported 回执） |
| | `r.ok` 假臂 | ✅ | 同 describe > 服务端解析失败（400）→ 透出服务端 message |

### knowledgeTools.ts / knowledgeMcp.ts（P2 增补）

| 函数 | 分支 | 覆盖 | 测试名 |
|---|---|---|---|
| `shapeFailure` | `e instanceof Error` 真臂 | ✅ | knowledgeTools.test.ts > 200 但响应形状不对（畸形 2xx）> 两条（TypeError） |
| | 假臂（`String(e)`） | ✅ | 同文件 > 写工具 > 抛出的不是 Error → 也降级成文本（String(e) 臂，不穿出 handler） |
| `kbCall` | `cfg` 为 null → 未连接文本 | ✅ | 未配置凭据（恒挂的降级路径）> 未登录时读工具（kbCall 壳）只回引导文本，且不发请求 |
| `kbWrite` | `cfg` 为 null → 未连接文本 | ✅ | 同 describe > 未登录时写工具（kbWrite 壳）同样只回引导文本，且不发请求 |
| | `op` 抛 → `shapeFailure` | ✅ | 写工具 > 写工具 200 但形状不对 → resolves（不是 rejects）… |
| `buildCreateDocumentTool` | 空间待定（`kind === "ask"`）→ 回文本 | ✅ | 写工具 > 写工具省略 spaceId 且多个空间 → 回问用户，不发写请求 |
| | `parentId` 真 / 假臂 | ✅ | 写工具 > create_document：给了 parentId 就带上（嵌套文档）；同 describe > create_document：带 spaceId 直接 POST… |
| `buildAppendDocumentTool` | `changeNote` 真 / 假臂 | ✅ | 写工具 > append_document：changeNote 给了就带上；同 describe > append_document：先 GET 再 PUT…（不带） |
| `buildUpdateDocumentTool` | 整条 handler（含 `title`/`changeNote` 真 / 假臂） | ✅ | 写工具 > update_document：先 GET 再 PUT，title/changeNote 给了就带上；同 describe > 省略 title/changeNote → 沿用当前标题、不带 changeNote |
| `buildIngestFileTool` | 空间待定 → 回文本（不上传） | ✅ | 写工具 > ingest_file：省略 spaceId 且多空间 → 回问用户，不上传（文件是否存在都轮不到） |
| | `parentId` 真 / 假臂 | ✅ | 写工具 > ingest_file：给了 parentId → 进查询串（两者都可选，undefined 不进 URL）；同 describe > ingest_file：相对路径按会话 cwd 解析… |
| | `cwd` 透传（会话工作目录） | ✅ | 同 describe > ingest_file：相对路径按会话 cwd 解析（cwd 由 buildKnowledgeTools 第二参给） |
| `buildKnowledgeTools` | 4 读 + 4 写的名字与顺序 | ✅ | buildKnowledgeTools > P2 后暴露 4 读 + 4 写，顺序稳定 |
| `knowledgeMcpRegistration` | `cwd` 第四参缺省（`""`） | ✅ | knowledgeMcp.test.ts 全部用例走缺省（`ingest_file` 的 cwd 由工具层测试单独覆盖） |
| 快照 | 工具表 + 两处 instructions 的 delta | ✅（逐字证死） | knowledgeMcp.test.ts > instructions 是 MCP 采纳率的必需品 > 工具描述快照…（快照 delta 已用脚本核过：只新增四工具块与第 6-9 条，其余逐字节相同） |

### P2 评审后续轮（独立 reviewer 提的四条，均已核实并落地）

| 项 | 处置 | 证据 |
|---|---|---|
| `append_document` 漏了单次 256 KiB 段落闸（spec §4.2 常量表与格式器注释都写明了「append 只算新增段落」，实现只查了拼完整篇） | 补闸（位于 GET 之前，与 create / update 同位） | 上表 `appendToDocument` 新增行 + commit `1fd321f9` |
| `useCustomizations.ts` 的镜像文案仍写「写工具见 P2」——spec §6.5 明确要求 P2 回填四个写工具名（计划里漏了这条任务） | 按实际形态回填：读四个自动放行 / 写四个每次要确认 | 纯静态文案，无分支；`builtinMcpServers` 无测试断言 |
| 客户端 32 MiB 闸对不上服务端的 2 MiB 硬顶（axum `Multipart` 的 `with_limited_body()` → axum-core `DEFAULT_LIMIT = 2_097_152`，且本 crate 未设 `DefaultBodyLimit`） | 服务端加 `INGEST_BODY_LIMIT`：**只挂 `/api/ingest`**（`post(upload).layer(DefaultBodyLimit::max(...))`），值 = 32 MiB **+ 64 KiB**（必须严格大于客户端闸：客户端量文件、服务端量整个 multipart 体） | `knowledge-server` `cargo check --all-targets` 通过、`cargo test` 10 passed；**已随 0.2.0 之前的那版层一起发过一版，本修正（严格大于 + 只挂一条路由）在 0.2.0 镜像之后，需再发一版才上线上** |
| `update_document` 对 >100k 字符的旧文会静默丢尾部（模型手里没有 read 截断之外的正文） | 写入照旧 + 回执警告（`warnTruncatedSource`），不阻断 | 上表 `updateDocument` 与 `format.ts` 新增行 |
