# Spike：agent 为什么有 LSP 还在 Grep

日期：2026-09-19
状态：**实测完成，结论部分可复跑；有一个实验被判定无效，见「无效实验」节。**

## 起因

用户观察：aide 装了 rust / ts 的 LSP 插件，agent 仍然高频 Grep。要求查明原因。

## 环境事实（先钉死，否则后面全是猜）

| 事实 | 证据 |
|---|---|
| agent 的 LSP 不是 aide 应用自己的 `src-tauri/src/lsp/`，而是 **Claude Code 内置 LSP 工具 + 官方 `.lsp.json` 插件** | `claude.exe` 进程命令行含 `--plugin-dir .../rust-analyzer-lsp/1.0.0` 与 `.../typescript-lsp/1.0.0` |
| 插件形态是声明式的，不是 MCP server | `~/\.aide/claude/plugins/cache/claude-plugins-official/{rust-analyzer-lsp,typescript-lsp}/1.0.0/.lsp.json` |
| server 配置 schema（从 CLI 二进制抠出） | 必需 `command` + `extensionToLanguage`；可选 `args` / `transport` / `env` / `initializationOptions` / `settings` |
| extension 注册是先到先得，冲突会上报 `lsp-extension-conflict` | 二进制内 Zod schema 与冲突检测代码 |
| `.lsp.json` 是插件根目录顶层条目，插件 manifest 可用 `lspServers` 声明 | 同上 |

## 结论

### 1. 根因：冷启动窗口内「空」冒充了「没有」（证据强）

rust-analyzer 由 CLI **懒启动**——第一次调用 LSP 工具时才拉起（实测 `rust-analyzer.exe` 进程创建时间 == 首次 LSP 调用时刻，父进程为本会话的 `claude.exe`）。

冷启动需要 **42–46 秒**（四次独立复现），期间 `textDocument/references` 返回的是**空数组**，不是错误：

```
14:23:50  冷启动后立刻调用  → No references found
14:25     约 90 秒后再调用  → Found 3 references  (80:12 定义 + 143:22 + 221:27)
```

这 3 条与 grep 真值完全一致。**agent 无法区分「真的没有引用」和「还没索引好」**，于是理性的选择是退回 Grep——而第一次调用通常发生在任务中途，46 秒的静默足以让任何 agent 放弃。

稳定期内存 **5.0–5.3 GB**（同一仓库四次采样，稳定不涨，非泄漏）。

### 2. TS 侧对 `.vue` 结构性失明（证据强）

`typescript-language-server` 的 `.lsp.json` 只映射 `.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts`，**没有 `.vue`**。

对 `applyTheme`（`src/themes/apply.ts:8:17`）查引用，只返回**定义自己**，漏掉 `App.vue:60/769/781` 与 `SettingsPanel.vue:38/380` 五处真实用法（grep 可证）。本仓库前端就是 Vue，**漏报是常态而非例外**。

### 3. `.vue` 支持不能靠"补一行映射"（证据强）

`@vue/language-server@3.3.11` 的 `peerDependencies` 是 `{"typescript": "*"}`。本机全局装的是 **typescript@7.0.2**（native/Go 重写版：`"type":"module"`、exports 只有 `./unstable/*`、**没有 `ts.server`**），npm 就用它填了 peer，并被嵌套进 Volar 的 `node_modules/`。

后果：Volar 在 `lib/server.js` 顶层取 `ts.server.protocol` → `TypeError` → **进程启动即崩**。照抄官网那份 `.lsp.json` 加 `.vue` 映射，结果是 server 根本起不来。

本地装 `@vue/language-server@3.3.11 + typescript@5.7.3` 可消除该崩溃（无嵌套副本，解析到 5.7.3）。

### 4. Volar 能否真正给出跨文件引用：**已定案——不能，而且原因在架构层**

（2026-09-19 后续实测补记，取代原先的「未决」。）

**`vue-language-server` 根本不是语言服务器，是 proxy。** 源码 `lib/server.js`：

```js
async function sendTsServerRequest(command, args) {
  return await new Promise(resolve => {
    tsserverRequestHandlers.set(requestId, resolve);
    connection.sendNotification('tsserver/request', [requestId, command, args]); // 发给**客户端**
  });
}
```

它把请求发给客户端、等客户端回 `tsserver/response`。宿主不桥接 tsserver，这个 Promise **永不 resolve** → 一条请求都不答。实测吻合：

| 测什么 | 结果 |
|---|---|
| 72KB `.vue`，`documentSymbol` | 零响应 125.9s |
| **10 行**的最小 Vue 项目，`documentSymbol` | 零响应 60s（排除「仓库太大」） |
| 崩的时候崩在哪 | `getLanguageService`（第一次功能请求），不是 `initialize` ← 正是要 tsserver 的那一刻 |

本机那份还额外崩：`@vue/language-server@3.3.11` 的**嵌套** `typescript` 被 npm 用全局
**7.0.2**（Go 原生重写版，`ts.server` 根本不存在）填了 peer → `ts.server.protocol` TypeError。
`--tsdk=<有 tsserverlibrary.js 的目录>` 能绕过崩溃（**注意必须是 `--tsdk=<path>` 带等号**，
源码里是 `arg.startsWith('--tsdk=')`；写成两个 token 会被静默忽略、退回嵌套那份再崩），
但**绕不开 proxy 架构**。

**结论：不要再往 `vue-language-server` 上使劲。**

### 5. `.vue` 的根治：tsserver + Vue 插件（**已实测可用**）

路线：`typescript-language-server` 载入 `@vue/typescript-plugin`（Volar 3 的现代做法，
tsserver 插件形态），**不新增任何进程**。

**关键开关：`tsserver.useSyntaxServer: "never"`。** 踩坑记录：TLS 默认会把请求分流给
**syntax server**，而 **syntax server 不加载插件**——于是单文件功能与引用查询全被那个
「没有 Vue 能力」的实例接走，表现为插件装了跟没装一样。这个坑很能骗人：日志里
`Loading global plugin @vue/typescript-plugin` **是打出来的**（semantic 实例确实加载了），
所以「插件加载失败」这个方向会把排查带偏。

复跑（真仓库，`applyTheme` 在 `src/themes/apply.ts:8:17`）：

```bash
node probe.mjs --server node --args "<tls>/lib/cli.mjs,--stdio" \
  --root <repo> --file src/themes/apply.ts --line 8 --col 17 --op references \
  --init-options '{"tsserver":{"useSyntaxServer":"never"},"plugins":[{"name":"@vue/typescript-plugin","location":"<abs>"}]}'
```

| 配置 | `applyTheme` 的 references |
|---|---|
| 不装插件 | count=1（只有定义自己） |
| 装插件、默认 useSyntaxServer | count=1 ← **看起来像插件没生效，其实是 syntax server 接走了** |
| 装插件 + `useSyntaxServer:"never"` | **count=7：`themes/index.ts` + `App.vue`×3 + `SettingsPanel.vue`×2**，与 grep 真值逐条吻合 |

**尚未解决的一条不对称**：`documentSymbol` 对 `.vue` **仍然不出结果**（30 次尝试 / 150s 零条）。
这对 aide 有直接影响——`lsp_agent` 的就绪探测 `probe_ready` **用的就是 documentSymbol**。
后果：`.vue` 目标上的**空结果**会被判成 `indexing` 而不是「已确认的没有」。方向是安全的
（绝不假阴性，符合红线），但 `.vue` 永远拿不到「确认没有」。
**候选修法**：`probe_ready` 改成探一个**同语言的普通源文件**（`lookup_symbol` 已经这么做），
而不是探被查询文件本身。

**依赖前提**：`@vue/typescript-plugin` 必须可达。本机它藏在
`<npm 全局>/@vue/language-server/node_modules/@vue/typescript-plugin`——**不能假设用户都有**，
所以产品化时要能探测到才启用、探不到就退回不用（别为了 Vue 把普通 TS 也搞坏）。

### 已落地（aide 侧）

- `src-tauri/src/lsp/vue_plugin.rs`（新）：按真实布局探测插件目录（项目本地 → 项目内嵌套
  → pnpm 内容寻址 → node 同级全局 → Windows npm 全局；判据是 `package.json` 在，不是目录在）
  + `has_vue_files()`（复用 `detector::find_source_file` 的有界遍历）。
- `src-tauri/src/lsp/profiles/ts.rs`：两个条件都成立才注入
  `plugins` + `tsserver.useSyntaxServer:"never"`；否则返回空对象，**行为与从前逐字相同**。
- `init_options` 的签名加了 `InitOptionsCtx { workspace, exclude_globs }`——原先只收
  `exclude_globs`，profile 根本拿不到工作区，按工作区做决策就无从谈起。
- `detector::find_source_file`（新）：有界遍历从 `agent_query::walk_for_language` 挪来，
  **边界纪律只留一份**（原来它是私有的，第二处用途出现时才发现该挪）。

**本机实况**：`which node` → WinGet 的 node → 命中全局嵌套候选；工作区 140 个 `.vue`
（第一个在深度 2）⇒ 两个条件都成立，注入生效。

**已知边界**：`.vue` 探测是有界遍历（深度 ≤4、跳 `node_modules`）。`.vue` 全在 4 层以下的
项目探不到 → 不启用（退回现状，不是错误）。`.vue` 作为**查询目标**（`{file: "X.vue"}`）
仍走 `LanguageId::Vue` → 那个坏掉的 `vue-language-server`，本批**没修**：本次的收益在
**TS 侧**（`.ts` 的引用查询看得见 `.vue` 用法），那正是 token 痛的来源。

## 提示词 A/B：能不能靠注入系统提示解决？（**结论：不能，已量化**）

问的判据是机器可判的：同一任务、同一模型、同一插件，唯一变量是 `--append-system-prompt-file`（内容 = `lspHint.ts` 真正注入的那 930 字符，由脚本从源码抽取，不会漂移）。

复跑：`bash run-lsp-ab.sh control|hint [run-id]`，`python analyze-ab.py ab-*.jsonl`。

任务：「找出函数 `is_excluded` 的所有调用点（不算定义/注释/字符串）」。该函数有 7 处真实调用点。

| 组 | LSP 调用 | Grep | 引用查询结果 |
|---|---|---|---|
| control  | **0** | 2 | — |
| control2 | **0** | 1 | — |
| hint     | 1 | 1 | EMPTY ×1 |
| hint2    | 3 | 2 | EMPTY ×2（外加一次**成功**的 documentSymbol） |

**两个结论：**

1. **提示词可靠地翻转了工具选择**（0 次 → 4 次）。机制有效。
2. **但没有换来一个可用的答案**：3 次 `findReferences` **100% 返回空**。

hint2 的调用序列尤其关键——agent **完全照做了提示词**：

```
 2. Grep: is_excluded
 3. LSP documentSymbol @247:8      ← 「先预热」，成功
 6. LSP findReferences @247:8      ← EMPTY
 9. LSP findReferences @247:10     ← 「稍后重试」，仍 EMPTY
10. Grep: isExcluded|is_excluded   ← 放弃，回到 Grep
```

两处位置都正确（247:8 落在 `is_excluded` 定义上）。失败原因是**两次尝试都落在约 46 秒的索引窗口内**。

「稍后重试」对模型不是可执行指令：它没有时钟，也拿不到「还没好」与「真的没有」的区别。**这两条只能由工具层提供**——这正是内置 LSP 工具缺的那一层。

**当前净收益 ≈ 0 甚至为负**：提示词让 agent 多打了 1–3 次注定为空的调用，答案仍来自 Grep。

## 无效实验（不要引用这里的数字）

原本想用 A/B 回答「传 `linkedProjects` / `files.exclude` 能否降低内存与冷启动」，**该实验无效**：

- A（默认）：45.9 s / 5.05 GB
- B（钉 `linkedProjects` + 排 `target`,`node_modules`）：43.1 s / 5.30 GB
- 判别实验 C：把 `linkedProjects` **故意钉到另一个 crate**，预期结果变 0——**结果仍为 3**

C 证明配置根本没有被采纳（先后试过包裹式与解包裹两种 `workspace/configuration` 应答形状，均无效）。因此 B 的「无差别」不构成任何结论：`files.exclude` 默认值是多少、`target`/`node_modules` 是否已被默认排除，**目前未知**。

要答这个问题必须走**真实送达路径**（`.lsp.json` 的 `initializationOptions`/`settings` → Claude Code 的 LSP 客户端 → RA），而不是手搓客户端。

## 复跑

```bash
cd docs/superpowers/spikes/2026-09-19-lsp-agent-tools

# RA 基线（冷启动耗时 + 峰值内存）
bash run-ra-ab.sh A        # 默认配置
bash run-ra-ab.sh B        # 钉 linkedProjects + 排除 target/node_modules

# 判别实验（验证配置是否被采纳；期望「钉错工程 → 结果变 0」）
#   实际结果仍为 3，即配置未被采纳

# Volar（需先 npm install，见下）
npm install @vue/language-server@3.3.11 typescript@5.7.3
node probe.mjs --server node \
  --args "<abs>/node_modules/@vue/language-server/bin/vue-language-server.js,--stdio,--tsdk,<abs>/node_modules/typescript/lib" \
  --root <repo root> --file src/themes/apply.ts --line 8 --col 17 --op references
```

`probe.mjs` 是最小 LSP 客户端（Content-Length 分帧、按 section 应答 `workspace/configuration`、轮询到非空为止）。位置参数是 **1-based**，发给 server 前转 0-based。

## C1 落地后的验收状态（2026-09-19）

### 已验证（机械可判）

| 项 | 结果 |
|---|---|
| Rust 侧单测 | `cargo test --lib` **893 passed** |
| sidecar 单测 | `vitest run` **1067 passed**（engine + extensions） |
| sidecar typecheck | 干净 |
| 构建新鲜度 | `dist/runtime.js` 含 `lsp_query` / `lsp_result` / `aide-lsp` / `lspLanguages` |

### 未验证：端到端（需要在跑的 app 里做）

**为什么验不了**：`lsp_query` 的往返需要三条链同时在场——sidecar 的 MCP server、
`runtime/mod.rs` 的拦截器、主进程的 `LspManager`。前两条只在真实会话里跑；而
仓库的 `MockLsp` 走**进程内 tokio duplex 管道**，不是可 spawn 的二进制，因此驱动不了
`ensure_server`（它必须从路径起真实进程）。要在此做集成测试，得给 `LspManager`
加一个仅供测试的句柄注入缝——**为测试去改生产代码的私有边界，不值得**。

**验收步骤**（开一个会话，让它做一件名字有歧义的检索）：

1. 工具是否挂载：会话里问「你现在有哪些 LSP 相关的工具」。期望看到
   `mcp__aide-lsp__lsp_symbols` / `lsp_references` / `lsp_definition` /
   `lsp_implementations` 四个。**看不到** = 四档闸门有一档没过，先查 `lsp_languages`
   是否下发（该工作区要真的有配得上 LSP 的语言）。
2. 语义查询是否可用：让它「找出 `LspManager::get` 的所有调用点」。期望一次
   `lsp_references` 返回**15 个精确调用点**（基线：裸 grep `.get(` 有 547 处噪音）。
3. 冷窗口的语义：**新开会话立刻**问同一句。期望**不是**「没有引用」，而是
   `indexing` 状态 + 「空不代表没有，重试或退回 Grep」的文案。这一条是本设计的
   全部意义所在——**若这里说出了「没有」，就是回归**。

验收结果请补回本节。

## C3 落地后的验收状态（退役内置通道）

设计见 spec § C3。机制：拼 `--plugin-dir` 时剔除声明 `.lsp.json` 的插件
（`extensions/lspRetire.ts`）——CLI 拿不到插件就不再挂内置 LSP 工具，也就不会再懒启动
第二个语言服务器。

### 已静态核验

| 项 | 结果 |
|---|---|
| CLI 有没有第二条插件发现路径 | **没有**。`~/.aide/claude/plugins/installed_plugins.json`（CLI 自己的注册表）只列 `superpowers` / `frontend-design`，**不含** `rust-analyzer-lsp` / `typescript-lsp` —— 那两个只存在于 aide 的 `enabled-plugins.json` |
| 退掉 LSP 会不会连带丢别的能力 | **不会**。两个官方 LSP 插件目录是纯 LSP（`.claude-plugin/` + `.lsp.json` + LICENSE + README） |
| 退役判据与挂载闸门会不会漂移 | 不会，同一个谓词 `lspToolsMounted`（`extensions/lspGate.ts`） |

### 未验证（要在跑的 app 里做）

1. **决定性判据**：任务管理器里同一仓库**只有一个** rust-analyzer（此前是两个）。
2. 内置 `LSP` 工具**拿不到答案**（不再出现 "No references found"）。
3. ⚠️ **别拿「内置 `LSP` 是否还出现在工具列表里」当判据**——「列在工具表」与「有 server
   可服务」是 CLI 的两件事，未实测；依赖它会把「已生效」误判成「没生效」。
4. 回归：某语言没配 LSP 的工作区里插件**不被剔除**。
5. **Read 接力徽章**（C3 会带走它，已按严格版补回）：让 agent 走一次「LSP 给出坐标 →
   Read 小段」的流程，期望工具卡头行出现 `✓ LSP 接力`。注意严格版的已知局限：
   `lsp_symbols {name}` 这种不带 `file` 的调用不给上下文，那种回合没有徽章是对的。
6. **市场插件卡**：`rust-analyzer-lsp` / `typescript-lsp` 卡片上应出现
   「语言服务器已由 Aide 接管，此插件不会生效」一行。

## 已排除的路径

**CLI 没有「预启动语言服务器」的开关。** 在 `claude.exe`（2.1.252）二进制里搜过 `lspServers` / `lspStartup` / `eager` / `warmup` / `prestart`：唯一命中的 `options.execution: ["default","eager"]` 配的是 `options.mode: ["summary","detailed"]`，属监控/报告类功能，与 LSP 无关。懒启动是 CLI 的设计，配置层改不掉。

## 未决问题

1. `files.exclude` / `watcherExclude` 的默认值，以及 RA 在本仓库上 5 GB 的构成（crate 图？未排除的 `target` 193 MB `node_modules` / 106 GB `target`？）—— 需真实送达路径才能量。
2. 日志中反复出现的 `WARN notify error: Input watch path is neither a file nor a directory.` 指向哪个路径？RA 的 watcher 在监看一个不存在的路径，可能是文件监听开销的来源。
3. ~~Volar 在本仓库上为何不响应（装置问题 vs 配置问题）。~~ **已定案，见 §4/§5**：
   不是装置问题，是 `vue-language-server` 的 proxy 架构 + TLS 的 syntax server 不加载插件。
4. `LSP` 未列入 aide 的 `allowedTools`（`agent-sidecar/src/engine/session-worker/queryOptions.ts:76`）——但 `Grep`/`Read` 也不在，两者同属内置只读工具，**推测无实际影响，未验证**。
