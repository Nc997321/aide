# CLAUDE.md — Aide

非官方桌面应用，用 Tauri v2 + Vue 3 为 Claude Agent SDK 提供带会话管理和文件树的 Chat 桌面壳（Node.js sidecar 驱动对话，不再是 xterm 套壳终端）。

详细架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，非必要不读取。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri v2 (Rust 后端 + WebView 前端) |
| 前端 | Vue 3 + Composition API + TypeScript |
| 终端 | xterm.js 5.x + xterm-addon-fit |
| 代码高亮 | highlight.js 11.x（仅打包 12 种语言） |
| Markdown 渲染 | marked 18.x（文件查看器 .md 预览） |
| 样式 | Tailwind CSS 3 + 双暗色主题（warm-dark 默认 / catppuccin），全项目三角箭头统一 `font-size: 14px` |
| 包管理 | pnpm |
| Rust 编译 | MSVC 工具链（VS Build Tools 2022） |

## 架构红线：跨平台 + 多 Agent 抽象

1. **跨平台**：当前主力平台是 Windows，但所有新代码必须兼容 macOS/Linux——路径拼接用 `PathBuf`/`path.join`（不硬编码 `\\`）、平台特有逻辑（如 `creation_flags`）必须 `#[cfg(windows)]` 隔离、shell 脚本 dev.ps1 / dev.sh 保持功能对等。
2. **多 Agent（Provider）抽象**：未来要接入 Claude 以外的 agent（OpenAI/Gemini 等）。因此：
   - **前端 Vue 层和 Rust 层必须保持 provider-agnostic**：只依赖统一的 `ChatEvent` / `SidecarCommand` IPC 协议（`agent-sidecar/src/types.ts` 与前端 `types/chat.ts` 镜像），不出现 Anthropic/Claude 专属类型或字段。
   - **Claude 专属逻辑只允许存在于 `agent-sidecar/`**（如 Anthropic 消息格式、Agent SDK 调用、SKILL 机制）。新 provider 的接入方式是新增一个 sidecar（或 Rust HTTP 客户端），输出同一套 `ChatEvent`。
   - 修改 IPC 协议时，先想清楚该字段是否所有 provider 都能提供；provider 专属信息放扩展字段，不污染核心协议。

## ⚠️ Windows 必读坑点：`CREATE_NO_WINDOW`

**所有 `Command::new("git")`（或任何 CLI 工具）必须加 `CREATE_NO_WINDOW (0x08000000)` 标志**，否则 Windows 会为每个子进程弹出一个控制台窗口，在 release build 中表现为大量错误弹窗。

```rust
#[cfg(windows)]
use std::os::windows::process::CommandExt;

let mut cmd = Command::new("git");
cmd.args(…);
#[cfg(windows)]
{ cmd.creation_flags(0x08000000); }  // 必须有！
```

涉及文件：`git.rs`、`marketplace.rs`、`filesystem.rs`、以及未来任何 spawn 外部进程的代码。

## ⚠️ Windows 必读坑点：`resource_dir()` 的 `\\?\` verbatim 路径

**Tauri `app.path().resource_dir()` 在 Windows 上返回带 `\\?\` 前缀的 verbatim（扩展长度）路径。凡是要把这种路径当入口脚本 / 可执行文件传给外部进程（尤其 `node`），传出前必须 `dunce::simplified()` 剥掉前缀**，否则 node 的 `realpathSync` 处理不了 `\\?\`，会在 `run_main` 引导阶段一路退化到 `lstat 'C:'` → `EISDIR` 崩溃。

典型现象：`pnpm tauri dev` 一切正常（dev 走 `CARGO_MANIFEST_DIR` 普通路径），**打包后一发消息就"会话进程已退出"**（release 才走 `resource_dir()`）。崩的是 runtime 进程引导，不是 claude.exe。

```rust
let path = resource_dir.join("agent-runtime").join("aide-agent.exe");
// ✗ cmd.arg(&path)                              // \\?\C:\... → 子进程引导崩
// ✓ cmd.arg(dunce::simplified(&path))           // C:\... 正常
cmd.env("AIDE_CLAUDE_EXE", dunce::simplified(&claude_exe)); // SDK 会 spawn 它，同样要剥
```

只用 Rust `fs::read_to_string` 读的资源路径不受影响（std 能吃 `\\?\`）——只有**传给外部进程**的才要剥。涉及文件：`runtime.rs`（`resolve_runtime_path`、`AIDE_CLAUDE_EXE`）、以及未来任何把资源路径交给子进程的代码。复现：把 `\\?\` 前缀路径当入口传给子进程必崩，去掉前缀正常。

## 关键约定

- **卡死诊断黑匣子（Freeze Flight Recorder）**：偶发「未响应」难复现（且卡死后**难以恢复、一直未响应直到强杀**），靠常驻黑匣子抓现场。前端 `useDiagnostics` 每 500ms 发 `diag_heartbeat`（携带 event loop 延迟 / longtask 摘要 / 用户面包屑增量）；Rust `diagnostics/watchdog.rs` 是独立 `std::thread`（不占 Tauri 主线程、不进 tokio runtime，谁卡它都活着），心跳断流 ≥2s → 冻结期每 500ms 主动采样 aide 进程家族 CPU/内存（`sysinfo`，仅冻结期跑、空闲零成本）+ 主线程 no-op 探针积压 + Windows `IsHungAppWindow`；**关键：冻结进行中每 ~2s 增量原子重写同一份报告**（文件名按 `started` 锚定，临时文件+rename），进程被强杀时最后一次写入留在磁盘（`recovered=false`），不依赖恢复才写——真正的现场证据来自 watchdog 侧采样帧，不依赖前端恢复。报告落 `~/.aide/diagnostics/freeze-<epoch>.json`（保留最新 20 份）；心跳真恢复时最终 flush 标 `recovered=true`，前端 30s 内自愈补交 longtask 明细 + 面包屑（`diag_freeze_supplement`，锦上添花，永不恢复时不发）。防误报/防噪声：首心跳前不检测、`document.hidden` 时两边都抑制、watchdog 自身 tick 缺口 >5s 判系统休眠标 `suspected_sleep`、时长 <4s 的短冻结丢弃。对现有代码侵入仅四处（`lib.rs`/`runtime.rs`/`main.ts`/`Cargo.toml`），其余纯新增可整体摘除；计数钩子挂在 provider-agnostic 的 `chat-event` 出口。设计文档 `docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md`。复发卡死后把 diagnostics 目录下最新报告丢给 Claude 分析。
- **sidecar 事件出口必须过 delta 合并层**：所有 stdout 事件统一经 `deltaCoalescer.ts` 输出——逐字 `*_delta` 在 40ms 窗口内按 key 拼接（几百条/秒 → ≤25 条/秒），非增量事件先冲刷缓冲再透传保序。未来新 provider 的 sidecar 同样要接这一层，禁止绕过它直写 stdout（逐字事件洪峰 × 前端每增量全量重渲染曾导致整窗 30s+ 卡死）。前端配套约定：已定稿文本块走 `renderMarkdown()` 缓存（`utils/markdown.ts`），流式尾块才直接 `marked.parse`；滚动置底必须 rAF 节流（读 `scrollHeight` 强制全容器布局）；消息列表禁止全量进 v-for——必须过 `useMessageWindow` 尾部窗口（数据层全量在 store，渲染层只挂尾部 N 条、上滚扩窗；切会话时新旧会话全量拆建 DOM 曾整窗未响应数十秒）；未标语言的代码围栏超 10KB 不做 `highlightAuto`（12 种语言各跑一遍的自动检测是挂载卡顿放大器）。
- **聊天滚动置底 = RO 双观察，禁止数据层枚举触发器**：`ChatPanel.vue` 的置底信号来自一个 `ResizeObserver` 同时观察**内容盒**（`.chat-messages-body`，包裹全部消息的纯布局 wrapper）和**滚动容器**（`.chat-messages` 自身）——内容增高（变更卡展开/图片加载/历史扩窗）和视口变化（权限弹窗 dock 挤压/Pane 拖拽/窗口缩放）两个症状源全覆盖；RO 通知按帧合并，回调只走既有的 rAF 节流 `scrollToBottom`（读 `scrollHeight` 强布局，频率与旧 watcher 同级），`autoScroll=false`（用户翻历史）时自身 no-op，置底只写 `scrollTop` 不改两者尺寸、无反馈循环。**教训**：数据层枚举「新消息/文本增量/块状态翻转」必然挂一漏万——Edit/Write 变更卡默认展开时 tool_call 追加在同一条消息内、结果到达就地换成几百 px 的 DiffViewer，两个 watcher 全部失明，滚动条悬在半中腰（2026-07-24 实锤）；权限弹窗挤压视口时 scrollTop 未被钳位则连 scroll 事件都不产生。新增块类型/新弹窗 dock 时**不需要也不允许**再补数据层置底触发器，DOM 层已兜底；两个保留的旧 watcher（`messages.length`、尾块文本长度）只是低成本的前置快路径。排查滚动问题的次序：先确认跑的是新 bundle（本轮"修完不生效"最终证实是旧 bundle 缓存），机制本身曾用同构复现页在 Edge headless（与 WebView2 同引擎）断言 6/6 全过。配套：变更卡（Edit/Write/NotebookEdit）不进 `ToolCallGroup` 折叠组（`blockSegments.isChangeTool`），对话流内默认展开、diff 统一走 `DiffViewer`（禁第二套 diff 渲染，旧 `editDiff.ts` 已删），头行「打开 ↗」经 `locateAnchorLine` 定位到改动行。
- **同步 command 禁止重 IO / 重 CPU**：Tauri 非 async command 跑在主线程上，遍历/大文件读取/大对象序列化/等子进程都会把窗口卡成「未响应」——这类命令一律 `async fn` + `spawn_blocking`。已改 async 的命令（重 IO/CPU 全员）：`grep_symbol`、`find_files_by_name`、`git_has_file`、`git_log/show/diff_*/status/branches/...`（git 命令全 async）、`load_messages`、`list_sessions`、`session_last_event`、`session_jsonl_size`、`session_truncate_jsonl`、`list_sessions_for_workspace`、`load_session_changes`、`save_session_changes`、`read_file_content`、`read_file_base64`、`read_file_binary`、`write_file_content`、`delete_file`、`copy_file`、`move_file`、`list_directory`、`detect_run_command`、`detect_run_targets`、`scan_plugin_skills`。判读：`aide.exe` 首帧 100% CPU + `pending` 单调涨 = CPU 烧后转 IO 堵的两段式同步命令；全程低 CPU = 纯 IO 同步命令。**async 化的两个坑**：(1) 命令带 `State<'_, T>` 等引用参数时，Tauri v2 强制 async 命令返回 `Result<_, _>`（编译错误 E0277 `async commands that contain references as inputs must return a Result`）——`scan_plugin_skills` 因此保留 `Result<Vec,_>`；纯 owned 参数的 async 命令可返回裸类型。(2) `State<T>` 不能跨 `spawn_blocking`，须把 state 注册成 `Arc<T>`（`lib.rs` `.manage(Arc::new(...))`），命令里 `let x = state.inner().clone();`（Arc clone，owned Send）再 move 进闭包。2026-07-08 黑匣子两轮真实冻结实锤两条漏网之鱼：首次 `session_jsonl_size`（目录遍历 IO，堵主线程 30s+，纯 IO 低 CPU）；第二次 `save_session_changes`——每轮 Claude 回完 `useConversationChanges.captureChanges → save` 都把累积的全部 `rounds` 整份 `serde_json::to_string_pretty` 落盘，序列化 CPU 满核、`fs::write` 是 IO（杀软扫描/磁盘争抢可拖到 27s），报告特征首帧 `aide.exe` 100% CPU 然后 CPU 掉但主线程仍堵（CPU→IO 两段式）。两轮后做了一次地毯式加固：剩余所有高危/中危同步命令（文件读写/复制/删除/列目录/run-target 检测/skills 扫描）全改 async 消灭主线程阻塞这一类。
- **`trace_command` 兜底**：保留同步、但做 IO/子进程/外部调用的命令埋 `diagnostics::trace_command()`，冻结时报告直接点名卡在哪条命令、跑了多久（`mainThread.stuckCommand`/`stuckForMs`）。形式：命令体第一行 `let _trace = crate::diagnostics::trace_command("函数名");`，在任何 IO/spawn 之前（带 `#[cfg]` 平台分支的命令要放在 cfg 块之前）。**只对同步命令有意义**——async 命令的 spawn_blocking 任务不在主线程，guard 在 dispatch 后立刻 drop，埋了也抓不到（禁止给 async 命令埋）。已埋 52 条（早期 3 条 `fetch_marketplace`/`install_plugin`/`git_fingerprint` + 2026-07-08 地毯式加固新增 49 条：全部 customizations/recent/settings/provider/file_assoc/file_open/show_in_explorer/get_project_info/pty_spawn_shell/run_process_start/stop/clipboard_*）。极轻纯内存命令（`file_exists`/`create_file`/`pty_write`/`poll_pty_output`/`rename_sidecar_session`/`get_default_*` 等）不埋（埋了是噪音）。新增同步命令时评估是否做重 IO/CPU/spawn——重则改 async，轻则不动，介于之间且保留同步的则埋 trace_command。
- **主题系统是配色的唯一来源（多主题必须可切换）**：配色一律走 `src/themes/` 的语义 token——`tokens.ts` 定义 `ThemeTokens`（bg / surface / text / accent / success|warning|danger|info / border / shadow / radius / space / **colorScheme** 约 26 个槽位），`warm-dark.ts`（默认）与 `catppuccin.ts` 各实现一份；`apply.ts` 把每个 token 写成 `:root` 上的 `--aide-<kebab>` CSS 变量（camelCase→kebab，如 `bgDeep`→`--aide-bg-deep`），`App.vue` 启动按 `settings.theme` `applyTheme`、`SettingsPanel.vue` 切换时即时 `applyTheme`。**`colorScheme` 是例外**：不是 `--aide-*` 变量而是浏览器原生 `color-scheme` 属性，`apply.ts` 对它特判直接 `root.style.setProperty("color-scheme", value)`，决定原生表单控件（复选框/未主题化 input）按 light/dark 渲染；暗色 `"dark"`、亮色 `"light"`。`global.css :root` 另留 `color-scheme: dark` 作首屏兜底。加亮色主题只需新主题文件给 `colorScheme: "light"`，其余不用动。**硬性规则：所有颜色/背景/边框/阴影/圆角/间距必须用 `var(--aide-*)`，禁止硬编码 hex；`tailwind.config.js` 的 `theme.extend` 为空、不定义任何颜色工具类（曾有的一套 Catppuccin 字面量已移除），需要新语义色就往 `ThemeTokens` 加槽位并在每个主题文件给值。** 新增主题＝新增一个实现 `ThemeTokens` 的文件 + 在 `themes/index.ts` 的 `themes` 注册表加 key。**主题开发封闭契约（主题=纯 token 文件、组件清单封闭、不允许主题私自新增/魔改组件、质感槽位表、玻璃后门配方、验收清单）见 [docs/reference/theme-development.md](docs/reference/theme-development.md)。** 验证：设置里切 warm-dark ↔ catppuccin，整窗应全部重配色；哪块没变就是漏了硬编码。
- **CodeMirror 主题化必须 `{ dark: true }` + 读源码确认类名**：`CodeEditor.vue` 的 `EditorView.theme(spec, { dark: true })` 第二参数不能漏——不传则 CodeMirror 当 light 主题，`&light` 自带默认值（白底按钮/输入框/面板）全部生效（搜索面板 next/previous 按钮白色就是因此）。传 `{ dark: true }` 让 `&dark` 默认值生效（即便漏写某选择器也不出白底），再用 `--aide-*` 精修。CodeMirror 自带 UI（搜索面板/补全/goto-line 对话框）的类名**必须读 `@codemirror/search`/`autocomplete`/`view` 的 dist 源码确认，不要猜**——具体坑（`.cm-panel.cm-search` 不是 `.cm-panel-search`；复选框/关闭按钮/补全 `<li>` 都没有想当然的类名，命中文字是 `.cm-completionMatchedText`）已写进 `CodeEditor.vue` 主题块的内联注释，查那里。语法高亮走 `createHighlightStyle(ThemeTokens)` 从 token 派生，不用 `oneDark`。
- **CodeMirror 字体必须设在 `.cm-scroller` 上，不是 `&`**：`@codemirror/view` 的 baseTheme 在 `.cm-scroller` 硬设 `font-family: monospace`，会盖掉 `&`（`.cm-editor`）上的继承值——`.cm-content`/`.cm-gutters`（代码字、行号）是 `.cm-scroller` 子节点，子节点自己的显式 `monospace` 胜过父节点继承 → 用户字体不生效（落到系统等宽 Consolas/Cascadia Mono，2026-07-23 实锤）。修法：在用户主题的 `.cm-scroller` 同名选择器加 `fontFamily: var(--cm-font-family)`，扩展主题优先级高于 baseTheme（等特异性 + 后注入胜出），`.cm-content`/`.cm-gutters` 随之继承用户字体。`font-size` 不受影响（base 没在 `.cm-scroller` 设 size），可用「size 生效、family 不生效」判定是不是这个坑。涉及 `CodeEditor.vue`、`fileviewer/DiffViewer.vue`；`--cm-font-family` 由 `applyFontSettings` 运行时 `setProperty` 到 `view.dom`，值取 `settings.fontFamily`（等宽栈默认 JetBrains Mono，栈常量 `MONO_FONT_STACK` 在 `src/utils/fonts.ts`，`--aide-font-mono` CSS 变量由 `useSettings` watch 同步）。
- **禁止原生浏览器 UI（tooltip / alert / confirm / prompt）**：一律走项目主题化组件，不要用会渲染系统原生外观的 API。hover 提示用 `v-tooltip` 指令（`src/directives/tooltip.ts`，全局注册于 `main.ts`，挂载时 `removeAttribute("title")` 并渲染 `.aide-tooltip` 卡片）——**禁止原生 `title="..."` 属性**（hover 出系统字体/配色的灰框，不随主题变）；静态字符串写 `v-tooltip="'文本'"`，变量写 `v-tooltip="expr"`。`ThemedSelect` 内部已把 `title` prop 接到 `v-tooltip`，外部传 `title=` prop 即可。弹窗用 `useModal`（`src/composables/useModal.ts` + `ModalDialog.vue`，全 `--aide-*`）的 `prompt`/`confirm`/`choice`/`notice` 四种模式——**禁止 `window.alert/confirm/prompt`**（浏览器原生标题栏 + 系统按钮）；纯告知用 `notice(title, msg, label)`（单按钮），错误提示等不能二值化的抉择用 `choice`。瞬时轻提示（操作回执，几秒自消）用 `useToast` + `src/ui/AToast.vue`（成功/失败/信息三态，挂相对定位容器里）。
- **非 scoped 样式**：xterm 动态 DOM（`WorkbenchTerminal.vue`、`BashOutputBlock.vue`）的样式必须放非 scoped `<style>` 块，否则 Vite scoped hash 导致样式不生效。
- **stderr 不是错误**：sidecar stderr 只进日志与 8 行尾部缓冲，仅进程意外退出时才发一条 error 事件（Node warning 曾被误报成错误导致会话假死）。
- **每会话独立 store**：`useChatSession` 的消息按 session_id 路由到模块级 store，前台/后台同一条写入路径；禁止「切换会话时拷贝缓存」的写法（曾导致跨会话数据污染）。
- **子代理 fan-out 成本治理**：子代理（Agent/Task）套子代理会让累计 input 按子代理数 × 内部轮数指数膨胀——实测一次 10 轮对话因 2 次调用嵌套展开成 79 个子代理、其中 18 个各加载 139K token 的 `claude-api` skill，累计 input 达 25M（历史同类 <1M）。三道防线（都在 provider-agnostic 层或 sidecar 内，不污染核心协议）：(1) **用量归因**——`TurnUsage` 带 `subagentTurn`/`subagentCount`/`byModel`，诊断面板把累计 input 拆成"含子代理轮次 / 纯主会话轮次"两栏，SDK 按模型聚合拿不到精确父子拆分，只能轮级归因；(2) **子代理重型 skill 守卫**——`agent-sidecar/src/skillGuard.ts` 的 `makeSkillGuardHook` 在子代理上下文（`agent_id` 非空）拦截名单内重型 skill（默认 `claude-api`，env `AIDE_HEAVY_SKILLS` 可覆盖，`AIDE_SUBAGENT_HEAVY_SKILL_GUARD=off` 关闭），主会话放行；是通用名单机制不是单 skill 补丁，新重型 skill 只加名单一项；(3) **嵌套软警告**——mapper 侧用 sidechain `parent_tool_use_id` 链算嵌套深度，超阈值（默认 >1，即子代理一旦派子代理就告警，env `AIDE_SUBAGENT_NESTING_WARN` 可配）发 `subagent_nesting_warning`（warn-only 不拦截）。**用法习惯**：只读审计/广搜类任务别做深嵌套 fan-out，用少数几个宽口径子代理并行；superpowers 全套流水线会编排轮次翻几倍，简单任务别上。
- **release 打包**：`tauri.conf.json` resources 带上 `agent-sidecar/dist/aide-agent.exe`（`bun build --compile` 把 esbuild 产物 `dist/runtime.js` 打成独立可执行文件，内嵌 Bun runtime，**不依赖系统 Node**）+ `claude.exe`（SDK 平台包里的原生 CLI，运行时经 `AIDE_CLAUDE_EXE` → `pathToClaudeCodeExecutable` 传给 SDK）+ `default-models.json` / `default-permission-modes.json`。注意 `tauri.conf.json` 的 `beforeBuildCommand` 只跑前端 `pnpm build`，**sidecar exe 需手动先构建**：`cd agent-sidecar && pnpm build && pnpm build:exe`（前者 esbuild 出 `runtime.js`，后者 bun compile 出 `aide-agent.exe`）。目前资源路径是 win32-x64 的，其他平台发布时需按平台调整。