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

### 6. TS 上 references 恒为空的**真因**：没 didOpen（2026-09-19 后续，真机暴露）

真机现象：右上角四个语言服务器全显示「就绪」，但 `mcp__aide-lsp__lsp_references`
反复回「索引未就绪，空结果不代表没有」，agent 等了 40s、90s 再试还是一样。

**面板没撒谎**：那个「就绪」是**握手就绪**——`src-tauri/src/lsp/mod.rs` 明写 Java 索引期
`ready=false`、**其余语言握手完就是 true**。它证明不了索引好。

真因是一组对比测出来的（同一配置、同一文件 `src/themes/apply.ts`）：

| | 开过文档（didOpen） | **没开** |
|---|---|---|
| `documentSymbol`（就绪探测用的就是它） | 6.0s，返回 2 个符号 | **永远 `[]`** |
| `references`（agent 发的那个） | **7 条**（含 5 条 `.vue`） | **永远 `[]`** |

**tsserver 只回答它打开过的文档。** Aide 的 agent 路径从不 didOpen → 查询空 + 探测也空
→ 恒报 `indexing`。服务器一直好得很，是没人给它递文件。

**为什么 C1 没做这一步**：Task 6 Step 1 专门实测过「server 要不要 didOpen」——但**只测了
rust-analyzer**（RA 的工程图来自 `cargo metadata`，未打开的文件照样答，实测确实不需要），
于是「按需 didOpen」被判为不实施。计划书末尾把这条风险**写下来了**并给了触发条件：

> 若将来换成确实需要 didOpen 的 server（jdtls / **tsserver 的某些操作**），`probe_ready`
> 会跟着失败 → 返回 `indexing` 而不是假装 `ready`……届时实施按需 didOpen 的触发条件 =
> 「在某个语言上观察到 references 恒为空且 probe 恒失败」。

TS 就是那个反例，条件已到（`908` 落地）。

**教训**：那次实测的结论是「RA 不需要」，而**被当成了「不需要」**。单语言实测推不出
跨语言结论——plan 自己也写着「若将来换成…」，但触发条件要靠**真机观察**才发现，
而它伪装成了「索引慢」这种随时会自愈的现象。**同类信号以后直接按触发条件处理，别再当偶发。**

**修法**（`src-tauri/src/lsp/`）：agent 查询路径在发请求前 `ensure_doc_open`（标
`DocOrigin::Agent`）；`probe_ready` 的探测靶子同样先打开。隔离靠来源标记：agent 打开的
文档（用户没开过）产生的诊断不进编辑器 UI。**来源升级**是配套的必要条件——编辑器后来
打开一个 agent 先递过的文件时，来源必须升级为 Editor，否则那个文件的诊断会被一路挡着
（静默：用户开着文件却看不到报错）。

## 已排除的路径

**CLI 没有「预启动语言服务器」的开关。** 在 `claude.exe`（2.1.252）二进制里搜过 `lspServers` / `lspStartup` / `eager` / `warmup` / `prestart`：唯一命中的 `options.execution: ["default","eager"]` 配的是 `options.mode: ["summary","detailed"]`，属监控/报告类功能，与 LSP 无关。懒启动是 CLI 的设计，配置层改不掉。

## 未决问题

1. `files.exclude` / `watcherExclude` 的默认值，以及 RA 在本仓库上 5 GB 的构成（crate 图？未排除的 `target` 193 MB `node_modules` / 106 GB `target`？）—— 需真实送达路径才能量。
2. 日志中反复出现的 `WARN notify error: Input watch path is neither a file nor a directory.` 指向哪个路径？RA 的 watcher 在监看一个不存在的路径，可能是文件监听开销的来源。
3. ~~Volar 在本仓库上为何不响应（装置问题 vs 配置问题）。~~ **已定案，见 §4/§5**：
   不是装置问题，是 `vue-language-server` 的 proxy 架构 + TLS 的 syntax server 不加载插件。
4. `LSP` 未列入 aide 的 `allowedTools`（`agent-sidecar/src/engine/session-worker/queryOptions.ts:76`）——但 `Grep`/`Read` 也不在，两者同属内置只读工具，**推测无实际影响，未验证**。

### 7. 按名查询（navto）与 references 同病：工程没加载（2026-09-19 后续，已修）

§6 修完 references 之后真机复跑，发现**按名查询仍然全灭**：`lsp_symbols {name}` 对
`useInlineMention` / `parseMentionPath` / `applyTheme` / `pathTypes` / `scanPluginSkills`
一律回 `no symbol named X`，每次都烧 ~31s（30s = `probe_ready` 预算）。而**同一个会话里**
拿坐标查 references 却精确命中——server 活着、符号在，只有按名这条路是死的。

复跑 `probe-navto.mjs`（最小客户端，只变 didOpen 这一个变量）：

| 步骤 | 结果 |
|---|---|
| didOpen 之前 | **JSON-RPC error：`No Project.`**（`navto` → `ThrowNoProject`） |
| didOpen 目标文件 +500ms | **count=1**，`useInlineMention` 精确命中（该文件就是定义处） |
| 对照组（不存在的名字） | count=0 空数组——与 error 可区分 |

```bash
node probe-navto.mjs --server node \
  --args "<node>/node_modules/typescript-language-server/lib/cli.mjs,--stdio" \
  --root <repo> --file src/composables/useInlineMention.ts --query useInlineMention
```

**结论：navto 与 references 是同一个病**——tsserver 只认它加载过的工程，didOpen 才触发加载；
908 那招（按需递文件）当时只治了 references 那条路。

三层各降级一次，最后拼出一句自信的假否定：

1. **rpc 层把 error 折叠成 null**：`rpc.rs::dispatch` 只读 `result` 字段，`error` 整个丢掉 →
   `Ok(Value::Null)`。「服务器拒答」与「服务器答了：没有」从此无法区分。（顺带发现：握手期
   那句 `result.get("error")` 校验**从来没触发过**——它检查的正是被丢掉的那个字段。）
2. **裁决跨语言合成**：`lookup_symbol` 拿任一语言的「ready + 空」当整个工作区的「确认没有」
   ——RA 对 `useInlineMention` 回空是天经地义的，却成了「TS 里也没有」的证据。
3. **提示词反向发许可证**：`LSP_INSTRUCTIONS` 第 4 条当时还说「TS 看不见 .vue，用 Grep 兜底」
   ——已过期：Vue 插件生效后，从 `.ts` 查 references **能**看见 `.vue` 用法（实测 2 条，全在
   `ChatInputBox.vue` 里）。

**本批改动**：`rpc.rs`/`transport.rs` 携带 `Result<Value, String>`（`RequestOutcome::ServerError`）；
`agent_query.rs` 逐语言裁决（`Absent` 需每个候选语言都被问到且都可信地回空，否则 `Unverified`
+ 点名谁没答）；按名查询前先递文件（`prime_project`）；sidecar 文案三处（删过期 .vue 条、
触发条件改成「问 where/who 就用」、歧义指示指向吃坐标的工具）。

**真机验收（待补）**：重启 app 后开新会话，问「`useInlineMention` 在哪定义、谁在用它」——
期望 `lsp_symbols` 一次命中（不再 30s 空转），references 结果里出现 `.vue` 里的调用点；
问一个**不存在**的名字，期望拿到 `indexing` + 逐语言明细，而不是 `no symbol`。

**仍未修**（下一步）：`.vue` 作为**查询目标**仍走 `vue-language-server` → 那个必崩的进程
每次查询被拉起一次（日志里每 30s 一条 `TypeError: ... ts.server.protocol`），既拖红面板
也让按名查询多一个「没答上的语言」。正解是让它也走 tsserver + Vue 插件。

### 8. 首轮真机测试暴露的两条（2026-09-19，两次独立会话）

**A. 按名查询是模糊的 → 假阳性（已修）**

两次会话各自撞上同一个坑：`lsp_symbols {name:"run_jump"}` 报「2 symbols」，第二处
`lsp/manager.rs` 的真身是 `answer_server_request_non_java_lang_returns_empty_settings`
——名字里根本没有 `run_jump`。隔离实验（一次会话提出，另一次复现）：查一个绝不存在的名字
`rnjmp`，rust-analyzer 回了 **11 个「符号」**，是子序列 `r…n…j…m…p` 凑出来的，其中还
包括真正的 `run_jump`。tsserver 的 `navto` 同样是前缀/子串打分。

**危害方向与假阴性相反且更贵**：问一个不存在的名字却拿到坐标，模型照着读，读到的是别人的
函数（假阴性只是绕路，假阳性是给错地址）。歧义文案还断言「N symbols named `X`」——那些
模糊候选根本不是这个名字。

改法：`agent_query::exact_matches` 在裁决前逐条对名字（剥掉参数表 `(...)` 与限定路径
`::`/`.` 后精确比较）。编辑器侧的 `lsp_workspace_symbol` **故意不过滤**——搜索框要的就是
模糊；同一份解析、两种语义，分界在 agent 那一层。

**B. 测试文件系统性缺席（记录为已知边界，改不了）**

`tsconfig.json:23` 排除 `src/**/*.test.ts` ⇒ 这些文件不在 TS project 里 ⇒ references 看不见
它们。实测**热索引下依然如此**：`useInlineMention` 的 references 只有 2 条（都在
`ChatInputBox.vue`），而文本层真值另有 `useInlineMention.test.ts` 7 处 + `ChatPanel.test.ts:67`。
这是项目配置决定的，只能在提示词里如实告知：已写进 `LSP_INSTRUCTIONS` 第 4 条（测试文件用
Grep 兜）。

**C. 判据修正：行号不是真值**

首轮测试 prompt 的期望表钉了行号（`useInlineMention.ts:82`、`ChatInputBox.vue:578`），当天就
烂了：仓库里**有别的会话在并行改代码并提交**（`82→69`、`578→580`，git 树干净=已提交）。两次
会话报的行号各自都正确，只是时刻不同。以后判据只给**文件名 + 数量**，不给行号。

**「这个会话跑的是哪个构建」的判据**：问一个不存在的名字——
「The index answered, but it has no symbol for …」= 旧构建；
带逐语言明细（谁答了、谁没答、为什么）的 `indexing` = 新构建。

### 9. 新构建首跑（2026-09-19）：修复生效，但暴露三条新事实

同一段测试 prompt 在新构建下的三条 `lsp_symbols`：

| 查询 | 结果（原文摘录） |
|---|---|
| `useInlineMention` | `failed (status: error): session stopped` —— 被会话收尾取消（`cancelAllLspQueries`），不是缺陷；**但这一问因此没测到** |
| `run_jump` | `no symbol named run_jump from typescript, javascript answered (empty); rust: it did not answer within the budget; vue: its server refused the query: Unhandled method workspace/symbol (code -32601)` |
| `zzzNotASymbolXyz` | 同形（TS/JS 空、rust 超时、vue 拒绝） |

1. **TS 侧按名查询这次作答了**（旧构建里它「始终没作答」——`No Project.` 被折叠成 null）。
   与 §7 的 `prime_project` 预期一致；**不能排他归因**（编辑器此刻也可能已打开过文件），
   但方向对。
2. **vue 不是「坏了」，是协议上没有这个能力**：`-32601 MethodNotFound`，而它的握手应答
   本来就没声明 `workspaceSymbolProvider`。改法：能力问询
   （`manager::declares_workspace_symbol`）——没声明就不发问，记为 `CannotAnswer`：
   **不参与裁决，但留一条披露备注**（`vue does not implement symbol search`）。
   不这样做的话，Vue 仓库的每次按名查询永远是「未验证」，确认否定这条价值归零。
   这是**刻意的取舍**：备注披露「谁的符号搜不到」，换回可用的否定。
3. **rust-analyzer 的 `workspace/symbol` 稳定超出 8s**（本轮 1 次 + 首轮会话 4/4 + 复现）
   → 专用 `SYMBOL_SEARCH_TIMEOUT = 20s`（只管这条查询，定义/引用仍是 8s）。
   **不是万能药**：RA 重建索引时更久也答不上，那时仍如实回「未验证」。

**仍未验证**：`useInlineMention` 那一问（TS 符号按名命中）被取消，没有结果。复跑只需这一条。

### 10. 第三跑：两个新 bug，其中一个把「查到了」说成「确认没有」（2026-09-19）

**A. `lsp_symbols` 的 happy path 一直是坏的**（已修）

名字解析**成功**之后（`run_jump` 定义已找到），代码把 `tool = "symbols"` 交给 `run_jump`，
而那里的 match 只认 references/definition/implementations —— `symbols` 掉进 `other` 分支回
`unknown tool`。于是 `lsp_symbols` 只有「查不到」和「同名多义」两条路能走，**真查到反而报错**；
更糟的是它当时用 `NoSymbol` 状态返回，侧车照 status 渲染成「confirmed negative」——
**一句内部错误被当成语义否定播给模型**。

修：`"symbols" | "definition"` 同路（名字已解析成坐标，落点就是 definition）；未知工具的状态
改成 `Error`（内部错误 ≠ 语义否定）。
**暴露它的正是上一批的模糊过滤**：过滤前 `run_jump` 是「2 candidates」走歧义分支，过滤后只剩
1 个真定义 → 撞进那条坏路。修一个 bug 逼出另一个，这是好事。

**B. navto 的空是竞态，不是「没有」**（已修）

`probe-navto.mjs --open` 序列（本仓库，`--query useInlineMention`）：

| 打开的文件 | 结果 |
|---|---|
| （什么都没开） | error `No Project.` |
| `vite.config.ts`（根层，tsconfig.node.json 只含它） | **0** |
| `src/composables/useMentionSuggest.ts` +4s | **0** |
| 同上 +20s | **1** |
| `src/composables/useInlineMention.ts`（目标本身） | **1** |

⇒ tsserver 打开工程内文件后，**配置工程仍在异步加载**，期间 navto 回**空数组而不是错误**；
加载窗口随机器负载浮动（复跑时 4s 就命中）。而 `probe_ready`（documentSymbol 探刚打开的那个
文件）一秒就过 ⇒ **加载中的空被认证成「确认没有」**——自信的假否定，比原 bug 更贵。

**顺带证伪一个候选判据**：`--peek`（对从没打开过的文件问 documentSymbol）两轮都是 0，
而同一轮 navto 已经命中 ⇒「peek 能证明工程加载好了」不成立，别再走这条路。

修：`search_symbol` 空结果每 2s 重试，预算 `SYMBOL_SEARCH_TIMEOUT`（20s）。
**这是概率收敛，不是证明**：工程加载慢于预算时仍可能假阴性——如实记在这里，别当它已经解决。

**C. 顺带**：RA 那个 `unusable payload` 是它回 `null`（JSON-RPC 合法的「无结果」），
与空数组同义 → 改成按空处理（仍要过就绪探针），真·畸形应答才报错。

### 11. 自己写的 E2E 推翻了 §10 的一半结论（2026-09-19 深夜）

`real_tsserver_finds_a_symbol_by_name_in_an_unopened_file`（`#[ignore]`；起真 tsserver 跑
`prime_project` + `search_symbol`，即 aide 自己的代码路径）**三次里空两次**：

| 递的代表文件 | 结果 |
|---|---|
| `find_source_file` 全仓第一个（= 根层 `vite.config.ts`，属只含它一个文件的工程） | 20s 空 |
| readdir 顺序前四个顶层目录（含测试文件） | **命中**（13s） |
| 按文件数排序 + 跳过测试文件 → 含 `src/api.ts`（正经主工程文件） | 20s 空 |

**结论：我们证明不了「符号索引覆盖了整个工作区」。** 空可能是「那个文件所在的工程没加载」，
而**没有任何 LSP 信号能证明加载完成**——就绪探针 `documentSymbol` 探的是「已递过的那个文件」，
工程没加载它照样过（三次全过）。既证明不了，就不许说「没有」：

- **按名查询的「确认没有」退掉了**：`SymbolLookup` 只剩 Found/Ambiguous/Unverified，
  空 → `indexing` + 逐语言原因 + 明说 not a confirmed negative。
  `AgentLspStatus::NoSymbol` 因此**没有产出点**（八个词是两侧冻结的契约，留着不删）。
- 递代表文件（每个顶层目录一个、按文件数排序、跳重目录、跳测试文件）**保留但降级**：
  它只影响**命中率**，不再影响结论。

**仍未解决**：tsserver 在多工程仓库里究竟何时把主工程加载进来。下一步只能靠
`probe-navto.mjs --open` 序列继续实测（单开 vs 多开、等多久、开哪个），**别再靠推理**。

### 12. 真凶是「多递文件」——一个自己也差点被当成未解之谜的坑（2026-09-20）

§11 那三次 E2E 空，根因不在 tsserver，在**我们自己递了几个文件**。同机同分钟的对照
（`probe-navto.mjs --open`，20s settle）：

| 预热的文件 | `workspace/symbol {useInlineMention}` |
|---|---|
| 只开 `src/api.ts` | **1**（命中） |
| 依次开 `src/api.ts` → `agent-sidecar/…` → `packages/aide-sdk/src/api.ts` → `ohos/hvigorfile.ts` | 1 → 1 → **0** → 1 |

**多工程并发加载时，navto 的答案随"那一刻哪些工程加载好了"抖动**——开得越多越抖。
只递一个（该语言文件最多的顶层目录里的第一个非测试文件）则稳：探针 4/4 命中，
E2E 改回单文件后 **2/2 命中，耗时 3.5s / 5.5s**（此前两连败是 20.9s / 22.5s）。

改法：`MAX_PRIMED = 1`。**"多递几个更保险"是反效果**——这条实验是本次最值钱的一课：
代表文件不是越多越好，多了反而互相干扰。

顺带确认：按名查询的**答案**现在只走两条路——命中（精确坐标）或**未验证**（逐语言原因）。
`no_symbol`（确认否定）没有产出点，等哪天有「工程已加载」的正向信号再接回来。
