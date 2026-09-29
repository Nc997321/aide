# 内置 LSP 设计

- 日期：2026-08-04
- 状态：设计已评审，待写实施计划
- 作者：Heaven + Claude（brainstorming）
- ⚠️ **局部失效（2026-09-29）**：语言探测与 Vue 归属已改——`.vue` 归 **TypeScript**（由 TS 服务器的 `@vue/typescript-plugin` 覆盖，独立的 `vue` 语言 id 已退役；`§语言探测方式` 里 `Tauri→{rust,ts,vue}` 的 vue 不再成立）；探测**下钻一级子目录**并改用有界扩展名遍历。三条扩展名轴（服务归属 `from_ext` / 文档 languageId `document_lang_id` / 探针靶子 `probe_exts`）以 `src-tauri/src/lsp/detector.rs` 抬头为准。本文其余设计（模块树、协议、信任门、排除目录）仍有效。

## 1. 背景与目标

Aide 已有完整代码编辑栈：CodeMirror 6 编辑器（`src/components/CodeEditor.vue`）、tree-sitter 符号索引 codegraph（`src-tauri/src/codegraph/`）、goto-definition 管线（`useGotoDefinition.ts`，已是 codegraph → grep 多 provider 链）、node sidecar 的 stdio 泵（`src-tauri/src/runtime/mod.rs`）。但缺**实时语言智能**——类型感知的诊断、补全、悬停、类型级跳转。

本设计内置 LSP（Language Server Protocol）支持：基于现有**项目探测器**检测工作区涉及的语言（可能跨语言），自动为每种语言拉起对应 LSP server，给编辑器接上诊断/补全/悬停/定义。**默认关闭**，按工作区粒度开启。

### 与 codegraph 的关系

不替代，并列。codegraph 跨文件离线精确（结构层 + 语义层），LSP 实时类型感知 + 诊断。LSP 可用时优先（定义/补全/hover 更准），codegraph 作 LSP 未起/不支持语言的离线兜底。续接 `useGotoDefinition.ts` 已有的多 provider 链。

## 2. 已定的关键决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| Server 二进制来源 | **捆核心 + 发现其余**：TS/JS（typescript-language-server）、Rust（rust-analyzer）随 tauri resources 捆绑，离线零配置；其余语言 `which::which` 发现 + 设置覆盖路径 | 复用现有捆绑 claude.exe/node 的 `resource_dir()` + `dunce::simplified()` + `creation_flags` 基建；装包体积可控 |
| 激活粒度 | **工作区级开关**（默认关），**不**用全局开关 | 全局开关一旦开，用户切多工作区点源码，server 跨工作区累积，内存爆 |
| 拉起时机 | **按文件懒启动**：开某语言文件才起该语言 server | 用即付费，跨语言天然（开 `.rs` 起 rust-analyzer，开 `.ts` 起 ts-server） |
| server 作用域 | `(workspace_root, language_id)` 一对；工作区关 / 该工作区 LSP 关 → 杀其名下全部 server | LSP server 天生 workspace-scoped（索引一个 rootFolder），不跨工作区共享；内存上界 = 活跃工作区数 × 该工作区活跃语言数 |
| v1 能力范围 | **全套**：诊断 + 定义 + 补全 + hover | 运输层双向 JSON-RPC 建一次，4 个 method 各是薄请求；复用现有 goto 浮层 + 诊断/补全样式槽 |
| 定义与 codegraph 关系 | LSP 定义与 codegraph **并列**，LSP 优先，codegraph 兜底 | 续接 `useGotoDefinition.ts` 多 provider 链，goto 浮层/导航栈零改 |
| 语言探测方式 | **扩展现有 ProjectDetector** 加 `languages()` 方法 + 文件扩展名兜底探测器 | 复用 16 个探测器 + 优先级链；Tauri→{rust,ts,vue}、Cargo→{rust}、Node→{ts,js}… |
| 架构方案 | **A：Rust 拥有 server 进程 + JSON-RPC** | 复用 runtime/mod.rs stdio 泵、codegraph 命令形状、cmCtrlHover 扩展范式、goto 链、`CREATE_NO_WINDOW`+`dunce`、workspace trust 门 |
| 工作区扫描边界 | 硬编码黑名单（复用 codegraph `ALWAYS_IGNORE_DIRS`）**+** 工作区级手动排除目录（IDEA 式）→ 并集注入 server init exclude + 我方 didOpen 跳过；tsserver/pyright 靠项目配置 | server 不自动尊重 .gitignore/黑名单；node_modules 等性能炸弹必须挡；用户手动排除特定目录（如生成的 `generated/`） |

## 3. 复用的现有基础设施

| 设施 | 出处 | 复用点 |
|---|---|---|
| tokio stdio 子进程泵 | `runtime/mod.rs:111-120` spawn + 三路 piped | server spawn 模板 |
| Windows `CREATE_NO_WINDOW` | `runtime/mod.rs:187` | server 子进程同样必须（否则弹窗） |
| `\\?\` verbatim 路径剥前缀 | `runtime/mod.rs` `dunce::simplified` | 资源路径传 server |
| oneshot 请求/响应路由 | `runtime/mod.rs:43,371-396`（image_probe_waiters） | LSP 请求/响应关联 |
| 主动推送 | `runtime/mod.rs:312` `app.emit("chat-event")` | `app.emit("lsp-diagnostics")` |
| 进程退出处理 | `runtime/mod.rs:314` EOF → break | server EOF → reject waiters |
| stderr 尾部缓冲 | `runtime/mod.rs:209,331-340` | server crash 日志 |
| 幂等 spawn + spawn_lock | `runtime/mod.rs:79-89` | `ensure_server` 幂等 |
| 命令形状 | `codegraph/mod.rs:576` `codegraph_goto_definition` | `lsp_definition` 等照搬签名 |
| 共享结果类型 | `codegraph/types.rs:65` `QueryResult` | LSP Location → QueryResult 映射，goto UI 零改复用 |
| managed state | `lib.rs` `.manage(Arc::new(CodeGraphState))` | `.manage(Arc::new(LspState))` |
| 命令注册 | `lib.rs:205` `generate_handler!` | 追加 `lsp_*` |
| 探测器责任链 | `commands/detectors.rs:17-107` | 加 `languages()` |
| 信任门 | `commands::workspace::is_workspace_trusted` | LSP 前置信任校验 |
| CodeMirror 扩展范式 | `src/extensions/cmCtrlHover.ts`（状态/事件/样式三层） | `cmLsp.ts` 同范式 |
| goto 多 provider 链 | `src/composables/useGotoDefinition.ts:20-90` | 插 LSP 为第一 provider |
| invoke 封装 | `src/api.ts:349` `codegraphGotoDefinition` | `lsp*` 封装 |
| 编辑器事务注解 | `src/utils/cmModelSync.ts:18` `isUserEdit` | didChange 仅用户编辑触发 |
| 诊断/补全样式槽 | `CodeEditor.vue:300-313,260-299` | `@codemirror/lint` / `@codemirror/autocomplete` 已样式 |
| markdown 渲染 | `src/utils/markdown.ts` | hover tooltip 内容 |
| 跳过目录黑名单 | `codegraph/indexer/walk.rs:13-34` `ALWAYS_IGNORE_DIRS` | 抽到共享 `src-tauri/src/ignore_dirs.rs`，codegraph + lsp 共用 |

## 4. 引入的依赖

- **`lsp-types`**（Rust crate）：LSP 标准消息类型的 serde 结构（DidOpen/DidChange/Definition/Completion/Hover/PublishDiagnostics/Position/Range/Diagnostic 等全有）。rust-analyzer/tower-lsp 都用。**仅类型库，非客户端**——不违背"自己写薄 JSON-RPC 派发器"的方案 A 原则。把自己写的代码收敛到 Content-Length 帧解析 + JSON-RPC 派发两块。
- 前端无新依赖：`@codemirror/autocomplete`、`@codemirror/lint` 已是 `basicSetup` 一部分（CodeEditor.vue:82 引用 `codemirror`，basicSetup 含两者）。

## 5. 架构

### 5.1 Rust 新模块 `src-tauri/src/lsp/`（形状照 `codegraph/`）

```
lsp/
├── mod.rs        LspState（managed state）+ lsp_* Tauri 命令 + lib.rs 注册
├── detector.rs   扩展 ProjectDetector.languages() + 文件扩展名兜底；detect_languages(root)
├── registry.rs   language→ServerSource 解析：settings 覆盖 > 捆绑(resource_dir) > PATH(which)
├── manager.rs    LspManager：HashMap<(workspace_root, lang), ServerHandle>；ensure/kill
├── transport.rs  每 server stdio 泵：Content-Length 帧读写 + oneshot 请求表
├── rpc.rs        JSON-RPC 派发：id 分配、请求/响应 oneshot 关联、server→client 通知路由
├── docs.rs       打开文档追踪：HashMap<Uri,{version,text}>；Full 同步
└── protocol.rs   仅本项目专属类型（如 QueryResult 映射）；LSP 标准类型用 lsp-types
```

**共享模块**：把 `codegraph/indexer/walk.rs:13-34` 的 `ALWAYS_IGNORE_DIRS` 抽到 `src-tauri/src/ignore_dirs.rs`（顶层共享，非 lsp/ 子模块），codegraph 的 `walk.rs` 改为 `pub use` 引用，lsp 的 exclude 构建也引用——单一真源，不重复硬编码。

**文件体量约束**：每子模块 80-250 行，mod.rs（命令层）最长 ~250 行。遵守项目红线：源文件超 1000 行必须拆，且提早拆。当前拆分已天然满足。

### 5.2 前端

- `src/extensions/cmLsp.ts`——CM 扩展，导出 `cmLsp({workspaceRoot, enabled}) -> Extension`，提供 didOpen/didChange（debounce 300ms）/ autocompletion source / lint source / hoverTooltip
- `src/composables/useLsp.ts`——工作区级控制器：on/off 状态、诊断 store、关区清理、事件监听
- `src/api.ts`——加 `lsp*` 封装
- `src/components/CodeEditor.vue`——extensions 数组加一行 `cmLsp({...})`；`goto-definition` emit payload 加 `column`
- `src/composables/useGotoDefinition.ts`——`search()` 插 LSP 为第一 provider
- 设置：工作区记录加 `lsp_enabled: bool`（默认 false）+ `lsp_exclude_dirs: Vec<String>`（手动排除目录，IDEA 式）+ `workspace_set_lsp_enabled` / `workspace_set_lsp_excludes` 命令；全局 `lsp.servers` 覆盖路径

### 5.3 两个关键集成决策

**定义触发**：保留 `CodeEditor.vue:109` Ctrl+Click emit，仅给 payload 加 `column`（`posAtCoords`→offset→char）。`useGotoDefinition.search()` 把 LSP 插为第一 provider（工作区 LSP 开且该语言有 server 时调 `lsp_definition`→`QueryResult[]`），空/错落到现有 codegraph→grep。goto 浮层、导航栈、`isGrepFallback` 标签全零改复用。cmLsp 不掺和定义触发。

**信任门**：复用 `is_workspace_trusted`。未信任工作区 `lsp_*` 命令前置校验返回 `{kind:"untrusted"}`，前端禁用 LSP——LSP 跑外部二进制 + 索引工作区，本就该走信任门。

### 5.4 工作区扫描边界（关键）

LSP server 收到 `initialize` + `workspaceFolders` 后会自己起后台索引（跨文件定义/补全/诊断需要全量项目模型）。server 按语言 manifest 走（rust-analyzer 按 Cargo crate 图、tsserver 按 tsconfig、pyright 按 pyproject/pyrightconfig、gopls 按 go.mod），构建产物多被语言自身规则挡住——**但 server 不自动尊重我们的 .gitignore 和硬编码黑名单**，且各家 exclude 机制不统一：

| server | exclude 机制 | 我们能否 init 注入 |
|---|---|---|
| rust-analyzer | `initializationOptions` excludeGlobs | 能 |
| gopls | `initializationOptions.directoryFilters` | 能 |
| typescript-language-server | tsconfig `exclude`（项目文件） | 不能（不替用户改项目文件） |
| pyright | `pyrightconfig.json` / `pyproject.toml [tool.pyright]`（项目文件） | 不能 |

**排除集构成**（单一真源 = `src-tauri/src/ignore_dirs.rs`）：

```
排除集 = ALWAYS_IGNORE_DIRS（硬编码黑名单）
       ∪ workspace.lsp_exclude_dirs（用户手动排除，IDEA 式，存工作区记录）
```

**三处应用**：

1. **init 注入**（rust-analyzer/gopls）：把排除集转成 `**/{dir}/**` globs 注入 server 的 init exclude 配置，挡住 server 后台全量扫描钻进 node_modules 等。
2. **我方 didOpen 跳过**（所有 server 通用兜底）：编辑器开文件时，路径落在排除集里 → 不发 `didOpen`，server 不为它建文档。即便 server 自己扫进去了，我们也不主动喂。
3. **tsserver/pyright**：靠用户项目自有的 tsconfig/pyright exclude（真实项目几乎都有，构建本来就需要）；v1 不替它们写配置文件。我方 didOpen 跳过仍生效。

**用户手动排除**：工作区记录加 `lsp_exclude_dirs: Vec<String>`（相对工作区根的目录路径，IDEA "Mark Directory as Excluded" 式）。命令 `workspace_set_lsp_excludes(workspace_root, Vec<String>)`；设置 UI 在工作区设置里加一个目录列表编辑器。改后对**已起**的 server 需重启才生效（server init exclude 不支持热改）——`workspace_set_lsp_excludes` 触发该工作区 server 重拉。

**v1 诚实边界**：项目特定 .gitignore 目录（不在硬编码黑名单、又未被语言 manifest exclude、用户也没手动加的）——LSP 仍可能扫。这类通常是少量源码/生成物，非 node_modules 量级，可接受。把 .gitignore 精确翻译给 server 不可行（server 吃 glob 不吃 gitignore 语法，且一半 server 从项目文件读），明确列为范围外。

## 6. 组件（职责 / 接口 / 依赖）

### Rust

**`lsp/detector.rs`**
- 职责：`detect_languages(root: &Path) -> Vec<LanguageId>`
- 实现：`ProjectDetector` 加 `fn languages(&self, root: &Path) -> Vec<LanguageId>`（默认空，各探测器覆盖：Tauri→`[rust,typescript,vue]`、Cargo→`[rust]`、Node→`[typescript,javascript]`、Go→`[go]`、SpringBoot→`[java]`、Flutter→`[dart]`、PythonDetector→`[python]`…）；链末加 `FileExtFallbackDetector`（无项目 marker 时扫一层目录扩展名频次）
- 依赖：`commands/detectors.rs`（扩展，不改 `detect_run_targets` 语义）

**`lsp/registry.rs`**
- 职责：`LanguageId → ServerSource`，解析 spawn 命令
- `ServerSource` 枚举：`Bundled{resource_subdir} | Which{binary} | Explicit{path,args}`
- `resolve(lang, settings) -> Option<ServerSource>`，优先级：`settings.lsp.servers[lang]` 覆盖 > 捆绑（`resource_dir/lsp/<lang>/<bin>`，`dunce::simplified`）> `which::which(binary)`
- `to_command(src) -> (program, args)` + 标准启动参数（`--stdio`）
- 依赖：`settings`、`resource_dir`、`which` crate

**`lsp/transport.rs`**
- 职责：每 server 一份，stdin/stdout 帧读写 + 请求/响应关联
- 接口：`LspTransport { async send(request)->Response, async notify(notification), reader_task }`
- stdin：`Arc<TokioMutex<ChildStdin>>`，写 `Content-Length: N\r\n\r\n{json}` 帧
- stdout：`tokio::spawn` reader，`Content-Length` 帧解析器（带缓冲状态机）→ `serde_json::Value` → 交 `rpc` 派发
- 请求/响应：`HashMap<RequestId, oneshot::Sender<Response>>`（照 `image_probe_waiters`）
- 依赖：`tokio`、`lsp-types`、`dunce`、`#[cfg(windows)] creation_flags(0x08000000)`

**`lsp/rpc.rs`**
- 职责：区分 Request（带 id，回 response）/ Notification（无 id）/ Response（匹配 waiter）/ Server→Client Request；id 用 `AtomicU64`
- 接口：`dispatch(msg) -> Action`（ResolveWaiter / EmitEvent / SendResponse / HandleServerRequest）
- server→client 通知路由：`publishDiagnostics`→`app.emit("lsp-diagnostics")`、`window/logMessage`→日志、`window/showMessage`→toast
- 依赖：`lsp-types`、`tauri::Emitter`

**`lsp/manager.rs`**
- 职责：`HashMap<(workspace_root, lang), ServerHandle>`，`ServerHandle = {transport, child, status}`
- 接口：`ensure_server(workspace, lang) -> Result<&Handle>`（幂等，`spawn_lock`）、`kill_workspace(workspace)`、`kill_server(workspace, lang)`、`dead_server` 标记、`restart_workspace(workspace)`（排除集变更后重拉）
- spawn 流程：resolve→spawn→initialize（**注入排除集 globs**，见 5.4）+initialized 握手→ready
- `build_exclude_globs(workspace) -> Vec<String>`：`ALWAYS_IGNORE_DIRS ∪ workspace.lsp_exclude_dirs` 转 `**/{dir}/**`
- 依赖：`registry`、`transport`、`ignore_dirs`（共享）、`settings`（读 `lsp_exclude_dirs`）

**`lsp/docs.rs`**
- 职责：`HashMap<Uri, {version, text}>`，per-server 一份
- 接口：`open(uri, text)`、`change(uri, text)->version++`（Full 同步）、`close(uri)`、`synced_version(uri)`
- 依赖：`lsp-types`

**`lsp/mod.rs`**
- `LspState(Arc<TokioMutex<LspManager>>)`，`lib.rs` `.manage(Arc::new(...))`
- 命令（全 `async fn`，照 `codegraph_goto_definition` 形状）：
  - `lsp_detect_languages(workspace_root) -> Vec<LanguageId>`
  - `lsp_ensure_server(workspace_root, lang) -> Result<{ok, server_not_found?}>`
  - `lsp_did_open / lsp_did_change / lsp_did_close(workspace_root, filePath, lang, text, version?)`（`did_open` 跳过落在排除集里的路径，见 5.4）
  - `lsp_definition(workspace_root, filePath, line, column) -> Vec<QueryResult>`
  - `lsp_completion(workspace_root, filePath, line, column, triggerKind) -> Vec<CompletionItem>`
  - `lsp_hover(workspace_root, filePath, line, column) -> {content: string|null}`
  - `lsp_shutdown_workspace(workspace_root)`
  - `workspace_set_lsp_enabled(workspace_root, bool)`（信任校验前置）
  - `workspace_set_lsp_excludes(workspace_root, Vec<String>)`（改排除集 → 触发该工作区 server 重拉）
- 依赖：以上子模块 + `codegraph/types.rs`（复用 `QueryResult`）+ `commands/workspace.rs`（信任）

### 前端

**`src/extensions/cmLsp.ts`**（三层）
- 状态层：`StateField<DiagnosticSet>` 存当前文件诊断（来自 `lsp-diagnostics` 事件，按 filePath 过滤）
- 事件层：`ViewPlugin` on create→`lsp_did_open`；`updateListener` 过滤 `isUserEdit`→debounce 300ms→`lsp_did_change`；destroy→`lsp_did_close`
- 样式层：无新增（复用 `.cm-diagnostic*` / `.cm-tooltip-autocomplete`）
- 导出：`cmLsp(opts: {workspaceRoot, enabled}) -> Extension`
- 提供三个 source：`autocompletion`（调 `lsp_completion`）、`linter`（读诊断 StateField）、`hoverTooltip`（调 `lsp_hover`→markdown.ts）
- 依赖：`@codemirror/autocomplete`、`@codemirror/lint`、`@codemirror/view`、`api.ts`、`useLsp`

**`src/composables/useLsp.ts`**
- 职责：工作区 on/off 状态、诊断 store、关区清理
- 接口：`isLspOn(workspace)`、`enableLsp(workspace)`、`disableLsp(workspace)`、`diagnosticsFor(filePath)`、监听 `lsp-diagnostics`/`lsp-server-dead`
- 依赖：`api.ts`、`useFileViewer`（文件开闭感知）

**`src/api.ts`**：加 `lsp*` 封装（照 `codegraphGotoDefinition`）

**`src/components/CodeEditor.vue`**：extensions 加一行；`goto-definition` emit payload 加 `column`

**`src/composables/useGotoDefinition.ts`**：`search()` 插 LSP 为第一 provider

## 7. 数据流

### 流 1：打开文件（LSP 开 + 已信任）

```
打开 foo.rs (workspace LSP on, trusted)
 → CodeEditor 挂载，cmLsp(enabled=true) ViewPlugin.create
 → invoke("lsp_did_open", {workspaceRoot, filePath, lang:"rust", text, version:1})
 → Rust lsp_did_open:
     manager.ensure_server(workspace, "rust")
       registry.resolve("rust") → Bundled("rust-analyzer")
       build_exclude_globs(workspace) → ["**/node_modules/**","**/target/**",... ,用户手动排除]
       spawn: tokio::piped + creation_flags + dunce
       transport reader_task 起 (Content-Length 帧)
       发 initialize（注入排除集 globs 到 init exclude）→ 收 capabilities → 发 initialized
     docs.open(filePath, version=1, text)
     发 textDocument/didOpen (notification)
     return Ok
 ↓ server 索引后推 publishDiagnostics
 → transport reader → rpc.dispatch → publishDiagnostics
 → app.emit("lsp-diagnostics", {workspaceRoot, filePath, diagnostics})
 → useLsp 监听 → 诊断 store → cmLsp StateField → @codemirror/lint 画波浪线
```

### 流 2：编辑

```
用户键入 → CodeEditor updateListener 过滤 isUserEdit (cmModelSync.ts:18)
 → emit update:modelValue → FileWindow v-model 更新 editContent
 → cmLsp debounce 300ms
 → invoke("lsp_did_change", {workspaceRoot, filePath, text, version: synced_version+1})
 → Rust lsp_did_change:
     docs.change(filePath, text) → version++
     发 textDocument/didChange (Full 同步：整份 text)
 ↓ server → publishDiagnostics(增量) → 同流 1 尾段 → 波浪线刷新
```

### 流 3：Ctrl+Click 跳转定义

```
Ctrl+Click (CodeEditor.vue:109)
 → emit("goto-definition", {word, filePath, line, column})  ← 新增 column
 → FileWindow onGotoDefinition → useGotoDefinition.search()
 → 1. (LSP 开 + 有 server) api.lspDefinition(filePath, line, column) → Vec<QueryResult>
        Rust: textDocument/definition (带 id) → oneshot 挂 waiter
        server → Location[] → 映射 QueryResult (复用 codegraph/types.rs:65) → resolve
        过滤自引用 → 非空 → 浮层渲染 → 结束
   2. (LSP 未开/无 server/空/错) 落 codegraph (useGotoDefinition.ts:39)
   3. (codegraph 空) 落 grep (useGotoDefinition.ts:65)
```

### 流 4：补全

```
键入触发 autocompletion
 → cmLsp autocompletion source → invoke("lsp_completion", {...})
 → Rust: textDocument/completion (带 id) → oneshot
 → server → CompletionList → 映射 CM Completion[]
 → resolve → CM 渲染 .cm-tooltip-autocomplete
新键击 → $/cancelRequest 取消上一条 → 发新请求（保持新鲜，不超时）
```

### 流 5：悬停

```
光标在某词上停顿
 → cmLsp hoverTooltip → invoke("lsp_hover", {...})
 → Rust: textDocument/hover (带 id) → oneshot
 → server → Hover{contents: MarkupContent} → 返回 {content: markdown|null}
 → cmLsp 用 markdown.ts 渲染 tooltip
```

### 流 6：关工作区 / 关 LSP

```
切走/关工作区 或 切 lsp_enabled=false
 → useLsp.disableLsp(workspace) → invoke("lsp_shutdown_workspace", {workspaceRoot})
 → Rust LspManager.kill_workspace(workspace):
     逐个 (workspace, lang) server:
       发 shutdown → 500ms 后 exit → child.start_kill()
       移除 handle
 → app.emit("lsp-diagnostics", {workspaceRoot, clear:true})
 → useLsp 清诊断 store → cmLsp StateField → 波浪线消失
 → 该工作区 cmLsp enabled 翻 false（不再发 didChange）
```

### 贯穿约束

- IPC 方向：前端→Rust 走 `invoke`（请求/响应）；Rust→前端走 `app.emit`（诊断推送、server 死通知）
- 请求/响应：所有 LSP request 走 `oneshot`，由响应到达 / server EOF / 前端 drop 三者之一终结，**无人为超时**
- Full 同步：每次 didChange 整份 text；大文件（>1MB）cmLsp 跳过 LSP 同步，codegraph/grep 仍可用

## 8. 错误处理

**核心原则**：我们的 transport/rpc 代码保证不挂（EOF/取消/drop 终结请求，不用超时兜底 bug）；server 是第三方进程，退出/乱发帧是它的现实，用进程 I/O 常识处理，不是"降级框架"。

| 场景 | 性质 | 处理 |
|---|---|---|
| server 二进制找不到 | 配置/环境，非 bug | `ensure_server` 返回 `{ok:false,kind:"server_not_found"}`；toast 一次；该语言落 codegraph/grep |
| 未信任工作区 | 权限门 | `lsp_*` 前置 `is_workspace_trusted` 校验，未信任直接拒 |
| server 进程退出（EOF / child exit） | 上游进程现实 | reader 检测 EOF → 批量 reject waiter → 标 dead → `app.emit("lsp-server-dead")`；下次 `did_open` 重拉。stderr 尾部 8 行入日志 |
| 帧损坏（非法 header / JSON） | 上游输出防御 | reader `continue` 跳帧，记日志，reader 不崩（照 `runtime/mod.rs:220`） |
| partial 帧（跨 read） | I/O 正常 | 帧解析器带缓冲状态机拼接；`transport.rs` 测试重点 |
| server 索引中（慢） | 非 bug，正常工作 | 不超时；`invoke` 异步，结果到了再显；补全用 `$/cancelRequest` 保持新鲜 |
| capability 缺失 | server 不支持某方法 | 对应请求直接返空（不发该 method），其余照常 |
| initialize 握手失败 | server 不达标 | 5s 内无 capabilities → 标 dead + toast「`<lang>` 握手失败」；落 codegraph（5s 是握手判活，非请求超时） |
| 重复 ensure_server | 幂等 | 已 alive 直接返现有 handle（`spawn_lock` + stdin 存在判断，照 `ensure_runtime`） |
| 关工作区 server 回收 | 生命周期 | 发 `shutdown` 请求 → 给 server 500ms grace period 响应 → 不论响应与否发 `exit` 通知 → `start_kill`；保 `kill_workspace` 一定回收。500ms 是我们自选的 grace period（非 LSP 协议规定值），给 server 优雅落盘的机会但不无限等 |
| 诊断版本错位 | 正确性 | 诊断携带 `version`，丢弃 < 当前 `synced_version` 的，防闪烁 |
| 大文件（>1MB） | 资源上界 | cmLsp 跳过同步，codegraph/grep 仍可用 |
| 打开排除目录里的文件 | 扫描边界 | `lsp_did_open` 检测路径落在排除集（§5.4）→ 不发 didOpen，server 不为它建文档；该文件无 LSP 能力，codegraph/grep 照常 |
| 请求泄漏 | 自愈 | 前端 drop promise → oneshot receiver 丢 → sender send 静默失败；server EOF → 批量 reject。无需超时清扫 |

## 9. 测试

照项目现有惯例：Rust 每文件内 `#[cfg(test)] mod tests`（detectors.rs:717、runtime/mod.rs:584）；前端 vitest（cmModelSync.test.ts）。

### Rust 单元测试

**`lsp/transport.rs`（最关键）**
- `framer_single_message` / `framer_split_across_chunks` / `framer_multiple_in_one_buffer` / `framer_partial_header` / `framer_empty_body` / `framer_garbage_header`
- `stdin_writer_frames`：写入带 `Content-Length` 头且 body 长度匹配
- `reader_eof_rejects_waiters`：stdout EOF → 所有挂起 oneshot 收到 reject

**`lsp/rpc.rs`**
- `dispatch_routes_request` / `dispatch_routes_response` / `dispatch_routes_notification`
- `dispatch_unknown_id_response`：无对应 waiter → 静默丢不崩
- `id_allocator_monotonic`

**`lsp/detector.rs`**（照 detectors.rs 风格）
- `tauri_yields_three_languages` / `cargo_yields_rust` / `node_yields_ts_js` / `go_yields_go` / `spring_boot_yields_java`
- `file_ext_fallback` / `cross_language_union`
- `existing_detectors_unaffected`：加 `languages()` 后 `detect_run_targets` 语义不变（回归保护）

**`lsp/registry.rs`**
- `precedence_settings_over_bundled_over_which` / `bundled_missing_falls_to_which` / `all_missing_returns_none` / `settings_args_passed_through`

**`lsp/manager.rs`**
- `ensure_server_idempotent` / `kill_workspace_kills_all` / `kill_server_single` / `dead_server_respawns_on_next_ensure`
- `restart_workspace_after_exclude_change`：`workspace_set_lsp_excludes` 后 server 重拉且新 init 注入含新 glob

**`ignore_dirs.rs`（共享）+ `manager.build_exclude_globs`**
- `always_ignore_dirs_unchanged`：抽取到共享后 codegraph `walk.rs` 行为不变（回归保护，照 `walk.rs:94` 测试）
- `exclude_globs_union_with_workspace_excludes`：黑名单 ∪ 用户手动排除 = 并集
- `exclude_globs_format`：转成 `**/{dir}/**` 格式正确
- `did_open_skips_excluded_paths`：路径在排除集 → `lsp_did_open` 不发

**`lsp/docs.rs`**
- `open_sets_version_1` / `change_increments_version` / `close_removes` / `synced_version_tracks`

**`lsp/mod.rs`**——测 `QueryResult` 映射
- `lsp_location_to_query_result`：LSP `Location{uri,range}` → `QueryResult{symbol:{file,line,column}}` 换算

### 前端测试（vitest）

**`src/extensions/cmLsp.test.ts`**（照 cmModelSync.test.ts）
- `did_change_debounced` / `did_change_skips_parent_sync` / `diagnostics_to_lint_mapping` / `completion_source_maps_items` / `lsp_disabled_no_op`

**`src/composables/useGotoDefinition.test.ts`**（扩现有）
- `lsp_first_then_codegraph_then_grep` / `lsp_error_falls_through`

### 集成测试

- **Mock LSP server**（`lsp/tests/mock_server.rs`）：极小 Rust 二进制，说 LSP 握手 + 对 `textDocument/definition` 回固定 `Location` + 推一条 `publishDiagnostics`。用于 transport+rpc+manager 端到端真 stdio 测试，CI 可跑。
- **真实 server 手测清单**：rust-analyzer（Rust）、typescript-language-server（TS）、pyright（Python）各跑一遍——诊断/补全/定义/hover/关区回收，记 PR 描述。不进 CI（慢 + 依赖外部安装）。

### 不测的（诚实声明）

- 真实 rust-analyzer 全协议兼容矩阵——v1 只覆盖 4 个 method + 诊断通知；server 扩展（如 `rust-analyzer/syntax`）不碰。
- 跨平台二进制矩阵——bundled server 在 macOS/Linux 拉起只手测清单覆盖。

## 10. 范围外 / 未来

- **增量文档同步**：v1 用 Full 同步（整份 text 每次 change）。未来按 `TextDocumentContentChangeEvent` 增量同步，省大文件带宽。
- **Problems 面板**：v1 只内联波浪线 + hover。未来加工作区级 Problems dock（聚合所有打开文件诊断）。
- **多 server 协调 / 工作区符号**：`textDocument/documentSymbol`、`workspace/symbol`、`references`、`rename`、`formatting` 等后续逐步加（每个都是薄请求）。
- **server 自动重启策略**：v1 crash 后下次 `did_open` 重拉，不自动重启指数退避。未来加。
- **`$/progress` 索引状态显示**：v1 不做，未来加"索引中"状态条。
- **第三方语言 server 插件化**：未来允许插件注册自定义 language→server 映射。
- **.gitignore 精确翻译给 server**：v1 只注入硬编码黑名单 + 用户手动排除；项目特定 .gitignore 规则不翻译（server 吃 glob 不吃 gitignore 语法，且 tsserver/pyright 从项目文件读）。未来若需要，可对支持 init exclude 的 server（rust-analyzer/gopls）做有损的顶层 .gitignore → glob 翻译。

## 11. 实施约束

- 遵守项目红线：源文件超 1000 行必须拆，且提早拆。当前 `lsp/` 子模块拆分已天然满足，实现时若某块膨胀立即再拆。
- Windows 红线：所有 `Command::new` 加 `CREATE_NO_WINDOW (0x08000000)`；资源路径传 server 前 `dunce::simplified()` 剥 `\\?\`。
- async command 带 `State<'_, T>` 引用参数须返回 `Result`（Tauri v2 E0277）；`State<T>` 不跨 `spawn_blocking`，注册成 `Arc<T>`。
- 同步命令禁重 IO/CPU；`lsp_*` 命令全 `async`。