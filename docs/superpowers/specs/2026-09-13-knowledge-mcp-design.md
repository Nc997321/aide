# 知识库读写内置插件设计（aide-knowledge MCP）

- 日期：2026-09-13
- 状态：设计定稿，等 spec 审阅后进实施计划
- 关联：`knowledge-server/README.md`（REST 契约）；CLAUDE.md「agent-sidecar 职责边界（extensions 层）」；CLAUDE.md「可替换技术藏在端口后面」（知识库是独立服务，本插件只做客户端，不把检索逻辑搬进 sidecar）
- 关联记忆：`aide-codegraph-agent-tools-adoption`（**instructions 是必需品**，不是优化）；`aide-cost-saving-levers`（恒挂工具的基座成本）

## 1. 背景与目标

`knowledge-server/`（独立 HTTP 二进制 `aide-knowledge`，默认 `127.0.0.1:8788`，Bearer 鉴权，PG 全文检索 + jieba 分词）目前**唯一的消费者是桌面前端**（`src/components/KnowledgeBase/kbClient.ts` 裸 fetch 直连）。agent 侧零代码：sidecar 与 `src-tauri/` 里 grep `knowledge` 零命中。结果：用户跟 agent 说「把刚才的结论存进知识库」，agent 既看不到也写不了。

**目标**：给 agent 一个内置 MCP 插件（`aide-knowledge`），让它在**用户明确提及知识库**时能查、能写。不做自动检索注入、不做自动归档——那些是后续迭代。

## 2. 范围

**做**：读 4 工具（search / read_document / list_spaces / list_documents）+ 写 4 工具（create_document / append_document / update_document / ingest_file），凭据经 `~/.aide/knowledge.json` 到 sidecar，工具**每次调用现读**该文件。

**不做（v1 明确排除）**：自动检索把片段注入上下文；会话结束自动归档；知识库自维护（改名/标签/合并/去重）；`knowledge` SKILL.md；向量检索（知识库侧本来就没有）；删除文档（知识库无此接口）；标签与双链（表已建、接口未做）。

## 3. 凭据通道：为什么是「文件 + 调用时现读」（方案 A）

三条候选，已定案 A：

| 方案 | 凭据路径 | 新鲜度 | 否决理由 |
|---|---|---|---|
| **A（定案）** | 前端推 → Rust 写 `~/.aide/knowledge.json` → 工具**每次调用**读文件 | 调用级 | — |
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

**空间不猜**（写工具共用的解析规则）：`spaceId` 可省略 → 可见空间**唯一**则用它；**多个** → 返回文本列出候选空间，让模型回头问用户。绝不默认往第一个空间写——那是共享资源。

**常量**（实现轮可调，先给值）：

| 常量 | 值 | 用途 |
|---|---|---|
| `KB_CONTENT_MAX_BYTES` | 256 KiB | **单次调用传入的 `content` 参数**上限（append 只算新增段落），超限返回引导文本 |
| `KB_DOC_MAX_BYTES` | 1 MiB | append / update **写回后的整篇正文**上限；超限返回引导文本，建议改用 import 本地文件 |
| `KB_READ_MAX_CHARS` | 100 000 | `read_document` 输出上限 |
| `KB_INGEST_MAX_BYTES` | 32 MiB | 导入文件上限 |
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

路径：`~/.aide/knowledge.json`（`our_config_dir()` 下，**独立文件**，不混进 `state.json`——诊断快照会 dump state.json）。

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
| 新命令 | `knowledge_set_runtime_config(base_url: String, token: Option<String>)` → 原子写 / 删 `~/.aide/knowledge.json`；返回 `Result<(), String>` |
| 同步还是 async | 轻 IO（一个几百字节文件）→ **保持同步 + 首行埋 `crate::diagnostics::trace_command("knowledge_set_runtime_config")`**（构建期守卫 `pnpm check:sync-io` 会扫所有做 IO 的同步命令） |
| 新增 env | spawn sidecar 时注入 `AIDE_KB_CONFIG_FILE`（绝对路径）。**只有路径，不是凭据** |
| 失败 | 写文件失败返回 Err 给前端（前端 best-effort 忽略，不阻塞登录） |

### 6.4 sidecar 文件层次

```
extensions/knowledgeMcp.ts        # 注册器：三道门 + createSdkMcpServer 组装（对齐 docsMcp.ts 的形状）
extensions/knowledgeTools.ts      # 8 个 buildXxxTool + ≤10 行编排主函数 buildKnowledgeTools(ctx)
extensions/knowledge/config.ts    # 凭据文件读取 + 校验（fail-closed）
extensions/knowledge/client.ts    # REST 薄客户端（fetch 可注入，便于单测；超时在此）
extensions/knowledge/format.ts    # 纯函数格式化器：失败原因 → 引导文本（单测主力）
```

`buildKnowledgeTools(ctx)` 是**目录骨架**：只做「把 8 个 builder 的返回值组成数组」，每个 builder 单独成形、各自 ≤40 行（用户结构约定）。`ctx` = `{ config 读取口, cwd, client }` 对象化（≤4 输入）。

`textResult()` helper 与 `codegraphTools.ts:127` 形状相同：**本插件自带一份（3 行），不为此做跨文件重构**。

### 6.5 装配三处（漏一处即失效）

| 位置 | 改动 |
|---|---|
| `engine/session-worker/queryContext.ts:93` | `assembleMcpServers({...codegraphMcp, ...docsMcp, ...knowledgeMcp}, userMcp)` |
| `engine/session-worker/queryOptions.ts:73` | `allowedTools` 加四条**读**工具规则（见 §7） |
| `packages/aide-sdk/src/composables/useCustomizations.ts` | `builtinMcpServers` 加 `{ id: "aide-knowledge", transport: "in-process", purpose: "内置知识库读写工具（search/read/list/create/append/update/ingest_file）；受信任工作区挂载，写操作走权限确认" }`——**没有动态事件，纯静态镜像，漏登记永久不可见** |

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

1. **token 明文落盘**（`~/.aide/knowledge.json`）：与 localStorage 现存风险等价；硬约束是永不进日志/错误消息。
2. **恒挂 ~8 个工具 schema**：不用知识库的用户也背 ~1k token 基座（进 prompt cache，约 10% 计费）；换取"中途登录即生效 + 可表达未登录"。
3. **知识库服务不由本应用 spawn**：它是独立部署的（docker compose / 手工 `cargo run`）。服务没起 → 工具返回网络引导文本，不是崩溃。
4. **代理**：sidecar 的 fetch 不自动走 HTTP_PROXY。知识库在 LAN/localhost 时无影响；远端部署 + 企业代理的组合留给后续（前端 kbClient 同样是裸 fetch，两边行为一致）。
5. **无乐观锁**：知识库 PUT 没有 versionNo，并发写入靠 300s 合并窗口兜底。追加工具内先读后拼已是最优，但仍非严格 CAS。
6. **多端**：remote-pwa / 鸿蒙驱动同一个桌面 sidecar，工具自动可用，无需改动；headless 无凭据文件 → 恒挂 + 引导文本（网关将来写这个文件即可打通）。

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

## 附录 B：分支覆盖对账表（模板，实现轮填实测）

| 函数 | 分支 | 覆盖 | 测试名 |
|---|---|---|---|
| `parseKbConfig`（config.ts） | 文件缺失 | ⬜ | — |
| | JSON 坏 | ⬜ | — |
| | token 空 | ⬜ | — |
| | version 未知 | ⬜ | — |
| | 正常 | ⬜ | — |
| `resolveSpaceId`（knowledgeTools.ts） | 传入 spaceId | ⬜ | — |
| | 省略 + 0 空间 | ⬜ | — |
| | 省略 + 1 空间 | ⬜ | — |
| | 省略 + 多空间 | ⬜ | — |
| `formatKbError`（format.ts） | 各失败原因 | ⬜ | — |
| `kbFetch`（client.ts） | 2xx / 401 / 403 / 404 / 409 / 5xx / 超时 / 网络 / 畸形 JSON | ⬜ | — |
| `knowledgeMcpRegistration` | env off / !trusted / taskTools / 正常 | ⬜ | — |
