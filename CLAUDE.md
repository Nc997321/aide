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

典型现象：`pnpm tauri dev` 一切正常（dev 走 `CARGO_MANIFEST_DIR` 普通路径），**打包后一发消息就"会话进程已退出"**（release 才走 `resource_dir()`）。崩的是 sidecar 自己的 `node sidecar.js`，不是 claude.exe。

```rust
let path = resource_dir.join("agent-sidecar").join("sidecar.js");
// ✗ cmd.arg(&path)                              // \\?\C:\... → node 崩 EISDIR 'C:'
// ✓ cmd.arg(dunce::simplified(&path))           // C:\... 正常
cmd.env("AIDE_CLAUDE_EXE", dunce::simplified(&claude_exe)); // SDK 会 spawn 它，同样要剥
```

只用 Rust `fs::read_to_string` 读的资源路径不受影响（std 能吃 `\\?\`）——只有**传给外部进程**的才要剥。涉及文件：`sidecar.rs`（`resolve_sidecar_path`、`AIDE_CLAUDE_EXE`）、以及未来任何把资源路径交给子进程的代码。复现：`node "\\?\C:\...\sidecar.js"` 必崩，`node "C:\...\sidecar.js"` 正常。

## 关键约定

- **卡死诊断黑匣子（Freeze Flight Recorder）**：偶发「未响应」难复现（且卡死后**难以恢复、一直未响应直到强杀**），靠常驻黑匣子抓现场。前端 `useDiagnostics` 每 500ms 发 `diag_heartbeat`（携带 event loop 延迟 / longtask 摘要 / 用户面包屑增量）；Rust `diagnostics/watchdog.rs` 是独立 `std::thread`（不占 Tauri 主线程、不进 tokio runtime，谁卡它都活着），心跳断流 ≥2s → 冻结期每 500ms 主动采样 aide 进程家族 CPU/内存（`sysinfo`，仅冻结期跑、空闲零成本）+ 主线程 no-op 探针积压 + Windows `IsHungAppWindow`；**关键：冻结进行中每 ~2s 增量原子重写同一份报告**（文件名按 `started` 锚定，临时文件+rename），进程被强杀时最后一次写入留在磁盘（`recovered=false`），不依赖恢复才写——真正的现场证据来自 watchdog 侧采样帧，不依赖前端恢复。报告落 `~/.claude-code-desktop/diagnostics/freeze-<epoch>.json`（保留最新 20 份）；心跳真恢复时最终 flush 标 `recovered=true`，前端 30s 内自愈补交 longtask 明细 + 面包屑（`diag_freeze_supplement`，锦上添花，永不恢复时不发）。防误报/防噪声：首心跳前不检测、`document.hidden` 时两边都抑制、watchdog 自身 tick 缺口 >5s 判系统休眠标 `suspected_sleep`、时长 <4s 的短冻结丢弃。对现有代码侵入仅四处（`lib.rs`/`sidecar.rs`/`main.ts`/`Cargo.toml`），其余纯新增可整体摘除；计数钩子挂在 provider-agnostic 的 `chat-event` 出口。设计文档 `docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md`。复发卡死后把 diagnostics 目录下最新报告丢给 Claude 分析。
- **sidecar 事件出口必须过 delta 合并层**：所有 stdout 事件统一经 `deltaCoalescer.ts` 输出——逐字 `*_delta` 在 40ms 窗口内按 key 拼接（几百条/秒 → ≤25 条/秒），非增量事件先冲刷缓冲再透传保序。未来新 provider 的 sidecar 同样要接这一层，禁止绕过它直写 stdout（逐字事件洪峰 × 前端每增量全量重渲染曾导致整窗 30s+ 卡死）。前端配套约定：已定稿文本块走 `renderMarkdown()` 缓存（`utils/markdown.ts`），流式尾块才直接 `marked.parse`；滚动置底必须 rAF 节流（读 `scrollHeight` 强制全容器布局）；消息列表禁止全量进 v-for——必须过 `useMessageWindow` 尾部窗口（数据层全量在 store，渲染层只挂尾部 N 条、上滚扩窗；切会话时新旧会话全量拆建 DOM 曾整窗未响应数十秒）；未标语言的代码围栏超 10KB 不做 `highlightAuto`（12 种语言各跑一遍的自动检测是挂载卡顿放大器）。
- **同步 command 禁止重 IO / 重 CPU**：Tauri 非 async command 跑在主线程上，遍历/大文件读取/大对象序列化/等子进程都会把窗口卡成「未响应」——这类命令一律 `async fn` + `spawn_blocking`。已改 async 的命令（重 IO/CPU 全员）：`grep_symbol`、`find_files_by_name`、`git_has_file`、`git_log/show/diff_*/status/branches/...`（git 命令全 async）、`load_messages`、`list_sessions`、`session_last_event`、`session_jsonl_size`、`session_truncate_jsonl`、`list_sessions_for_workspace`、`load_session_changes`、`save_session_changes`、`read_file_content`、`read_file_base64`、`read_file_binary`、`write_file_content`、`delete_file`、`copy_file`、`move_file`、`list_directory`、`detect_run_command`、`detect_run_targets`、`scan_plugin_skills`。判读：`aide.exe` 首帧 100% CPU + `pending` 单调涨 = CPU 烧后转 IO 堵的两段式同步命令；全程低 CPU = 纯 IO 同步命令。**async 化的两个坑**：(1) 命令带 `State<'_, T>` 等引用参数时，Tauri v2 强制 async 命令返回 `Result<_, _>`（编译错误 E0277 `async commands that contain references as inputs must return a Result`）——`scan_plugin_skills` 因此保留 `Result<Vec,_>`；纯 owned 参数的 async 命令可返回裸类型。(2) `State<T>` 不能跨 `spawn_blocking`，须把 state 注册成 `Arc<T>`（`lib.rs` `.manage(Arc::new(...))`），命令里 `let x = state.inner().clone();`（Arc clone，owned Send）再 move 进闭包。2026-07-08 黑匣子两轮真实冻结实锤两条漏网之鱼：首次 `session_jsonl_size`（目录遍历 IO，堵主线程 30s+，纯 IO 低 CPU）；第二次 `save_session_changes`——每轮 Claude 回完 `useConversationChanges.captureChanges → save` 都把累积的全部 `rounds` 整份 `serde_json::to_string_pretty` 落盘，序列化 CPU 满核、`fs::write` 是 IO（杀软扫描/磁盘争抢可拖到 27s），报告特征首帧 `aide.exe` 100% CPU 然后 CPU 掉但主线程仍堵（CPU→IO 两段式）。两轮后做了一次地毯式加固：剩余所有高危/中危同步命令（文件读写/复制/删除/列目录/run-target 检测/skills 扫描）全改 async 消灭主线程阻塞这一类。
- **`trace_command` 兜底**：保留同步、但做 IO/子进程/外部调用的命令埋 `diagnostics::trace_command()`，冻结时报告直接点名卡在哪条命令、跑了多久（`mainThread.stuckCommand`/`stuckForMs`）。形式：命令体第一行 `let _trace = crate::diagnostics::trace_command("函数名");`，在任何 IO/spawn 之前（带 `#[cfg]` 平台分支的命令要放在 cfg 块之前）。**只对同步命令有意义**——async 命令的 spawn_blocking 任务不在主线程，guard 在 dispatch 后立刻 drop，埋了也抓不到（禁止给 async 命令埋）。已埋 52 条（早期 3 条 `fetch_marketplace`/`install_plugin`/`git_fingerprint` + 2026-07-08 地毯式加固新增 49 条：全部 customizations/recent/settings/provider/file_assoc/file_open/show_in_explorer/get_project_info/pty_spawn_shell/run_process_start/stop/clipboard_*）。极轻纯内存命令（`file_exists`/`create_file`/`pty_write`/`poll_pty_output`/`rename_sidecar_session`/`get_default_*` 等）不埋（埋了是噪音）。新增同步命令时评估是否做重 IO/CPU/spawn——重则改 async，轻则不动，介于之间且保留同步的则埋 trace_command。
- **主题系统是配色的唯一来源（多主题必须可切换）**：配色一律走 `src/themes/` 的语义 token——`tokens.ts` 定义 `ThemeTokens`（bg / surface / text / accent / success|warning|danger|info / border / shadow / radius / space / **colorScheme** 约 26 个槽位），`warm-dark.ts`（默认）与 `catppuccin.ts` 各实现一份；`apply.ts` 把每个 token 写成 `:root` 上的 `--aide-<kebab>` CSS 变量（camelCase→kebab，如 `bgDeep`→`--aide-bg-deep`），`App.vue` 启动按 `settings.theme` `applyTheme`、`SettingsPanel.vue` 切换时即时 `applyTheme`。**`colorScheme` 是例外**：不是 `--aide-*` 变量而是浏览器原生 `color-scheme` 属性，`apply.ts` 对它特判直接 `root.style.setProperty("color-scheme", value)`，决定原生表单控件（复选框/未主题化 input）按 light/dark 渲染；暗色 `"dark"`、亮色 `"light"`。`global.css :root` 另留 `color-scheme: dark` 作首屏兜底。加亮色主题只需新主题文件给 `colorScheme: "light"`，其余不用动。**硬性规则：所有颜色/背景/边框/阴影/圆角/间距必须用 `var(--aide-*)`，禁止硬编码 hex；`tailwind.config.js` 的 `theme.extend` 为空、不定义任何颜色工具类（曾有的一套 Catppuccin 字面量已移除），需要新语义色就往 `ThemeTokens` 加槽位并在每个主题文件给值。** 新增主题＝新增一个实现 `ThemeTokens` 的文件 + 在 `themes/index.ts` 的 `themes` 注册表加 key。验证：设置里切 warm-dark ↔ catppuccin，整窗应全部重配色；哪块没变就是漏了硬编码。
- **CodeMirror 主题化必须 `{ dark: true }` + 读源码确认类名**：`CodeEditor.vue` 的 `EditorView.theme(spec, { dark: true })` 第二参数不能漏——不传则 CodeMirror 当 light 主题，`&light` 自带默认值（白底按钮/输入框/面板）全部生效（搜索面板 next/previous 按钮白色就是因此）。传 `{ dark: true }` 让 `&dark` 默认值生效（即便漏写某选择器也不出白底），再用 `--aide-*` 精修。CodeMirror 自带 UI（搜索面板/补全/goto-line 对话框）的类名**必须读 `@codemirror/search`/`autocomplete`/`view` 的 dist 源码确认，不要猜**——具体坑（`.cm-panel.cm-search` 不是 `.cm-panel-search`；复选框/关闭按钮/补全 `<li>` 都没有想当然的类名，命中文字是 `.cm-completionMatchedText`）已写进 `CodeEditor.vue` 主题块的内联注释，查那里。语法高亮走 `createHighlightStyle(ThemeTokens)` 从 token 派生，不用 `oneDark`。
- **禁止原生浏览器 UI（tooltip / alert / confirm / prompt）**：一律走项目主题化组件，不要用会渲染系统原生外观的 API。hover 提示用 `v-tooltip` 指令（`src/directives/tooltip.ts`，全局注册于 `main.ts`，挂载时 `removeAttribute("title")` 并渲染 `.aide-tooltip` 卡片）——**禁止原生 `title="..."` 属性**（hover 出系统字体/配色的灰框，不随主题变）；静态字符串写 `v-tooltip="'文本'"`，变量写 `v-tooltip="expr"`。`ThemedSelect` 内部已把 `title` prop 接到 `v-tooltip`，外部传 `title=` prop 即可。弹窗用 `useModal`（`src/composables/useModal.ts` + `ModalDialog.vue`，全 `--aide-*`）的 `prompt`/`confirm`/`choice`/`notice` 四种模式——**禁止 `window.alert/confirm/prompt`**（浏览器原生标题栏 + 系统按钮）；纯告知用 `notice(title, msg, label)`（单按钮），错误提示等不能二值化的抉择用 `choice`。瞬时轻提示（操作回执，几秒自消）用 `useToast` + `src/ui/AToast.vue`（成功/失败/信息三态，挂相对定位容器里）。
- **模型选择器生命周期（切换回执 + 按会话记忆）**：运行时切换统一走 `agent-sidecar/src/modelSwitch.ts`（`applyModelSwitch`）——query 未起存本地 fallback（对齐 `applyPermissionMode`，禁止可选链静默丢弃），成功坐实+广播，**失败回滚广播+发 `model_switch_result` 事件**（前端 ChatPanel 据此弹 AToast，成败必须可区分，禁止 `.catch(() => {})` 吞错）。未启动（停止/历史）会话没有 sidecar：Rust `set_model` 无活进程返回 `false`（不是错误），前端本地合成 `deferred:true` 回执走同一 toast 链路（文案「已选定，将在发送后生效」），选择随下一条消息 `initialModel` 生效——两条路径都不允许静默。每条 assistant 消息的真实 wire model（API 落盘标识）由 sidecar 盖在该消息首个块事件上（`model`/`modelLabel`，占位符/错误回声不盖），前端消息气泡显示模型徽标（别名建议在可选项列表里才采信，否则显示 wire 原文）——**「这条回答出自哪个模型」以此为准，模型自报身份不可信**（kimi 系被问"你是什么模型"会按训练身份回答，与 wire model 无关）。模型选择按会话持久化在元数据 `sessions/<id>.json` 的 `model` 字段（Rust `set_session_model` merge 写 / `session_model` 读回）：写入两处——用户显式切换（`useChatSession.setModel`）与 ChatPanel currentModel watcher 的坐实值（**只记在当前可选项列表里的值**——sidecar 会把第三方 wire id 解析成 Claude 别名广播，别名不在真实 id 列表里，记了恢复不出来）。恢复在 `ChatPanel` 的 sessionId watcher：历史/停止会话读回 remembered，在列表里才采信（停会话期间换过 provider 则退默认），pending 会话和存活会话（SDK 坐实值优先）不恢复。配套：sidecar `currentModel` 从 `ANTHROPIC_MODEL` env 初始化（spawn 即知模型），init 广播立刻坐实选择器，消除恢复竞态。
- **子代理模型：主代理动态选择优先，provider 配置只做兜底（hook 下发，不是 env 钉死）**：CLI（claude.exe）的子代理模型解析顺序是 `CLAUDE_CODE_SUBAGENT_MODEL` env > Agent 工具调用的 `model` 参数 > AgentDefinition.model > 继承主模型——env 是**硬覆盖**，曾把主代理「dispatched (sonnet)」这类逐次动态选择全压成 provider 配置值。修复：sidecar 不把该 env 原值透传给 CLI（压成 `"inherit"`，顺带清洗用户 shell 泄漏），provider 的子代理模型改由 `agent-sidecar/src/subagentModelDefault.ts` 折算后**经 PreToolUse hook 在 Agent/Task 工具输入无 `model` 时注入 `updatedInput`** 兜底。折算规则（Agent 工具 `model` 是 zod enum 只收 sonnet/opus/haiku/fable，且 hook 的 `updatedInput` 会被 CLI 重新 safeParse——必须是完整输入、不能注全 id）：值本身是别名→直接用；值==某个 `ANTHROPIC_DEFAULT_*_MODEL` 映射值→用对应别名；都兜不上（独立全 id）→退回 env 硬钉死现状。hook 只带 `updatedInput` 不带 `permissionDecision`，走 CLI 的 hookUpdatedInput 纯输入替换通道，不碰权限流（`allowedTools` 自动批准、dontAsk/bypass 行为不变）。
- **非 scoped 样式**：xterm 动态 DOM（`WorkbenchTerminal.vue`、`BashOutputBlock.vue`）的样式必须放非 scoped `<style>` 块，否则 Vite scoped hash 导致样式不生效。
- **通知不依赖插件**：直接用 `notify-rust`（`notify_send` 命令），强制 `app_id("com.aide.app")`，绕过 tauri-plugin-notification dev 模式跳过 app_id 的 bug。
- **会话 ID 生命周期（延迟创建）**：点"新建会话"只清空 `activeSessionId`，打开空白面板，不落盘、不进侧栏。首次发消息时若无 session id，`useChatSession.ts` 现场生成一个纯内存临时 key（`crypto.randomUUID()`，记入 `pendingSids`），不落盘直接调 `send_message`。SDK 首次 `session_init` 带回真实 id 后才是"创建"真正发生的时刻：Rust `rename_sidecar_session` 原地改 sidecar 进程注册表（内存操作，无 IO），前端 `finalizeSession` 原地搬迁 `stores`/`sessionState`，随后 `onSessionCreated` 回调里 App.vue 才第一次调 `create_session(id, name)` 写元数据、`addSession` 加侧栏、`recordCurrentSession` 记最近访问。此后 aide ID 永远等于 SDK session ID，不再改名。历史会话续接：resume 直接用 `sid` 本身（`isPendingSession(sid) ? undefined : sid`），无需任何映射表。若发消息后从未等到 `session_init`（进程崩溃等），什么都不落盘，不留孤儿文件。
- **状态语义**：`running`（生成中）/ `attention`（等权限确认）/ `waiting`（sidecar 存活空闲，message_stop 后）/ `stopped`（进程不在）。通知、任务栏进度、变更捕获都依赖 `running→waiting` 转换，不要把 message_stop 改成 stopped。
- **stderr 不是错误**：sidecar stderr 只进日志与 8 行尾部缓冲，仅进程意外退出时才发一条 error 事件（Node warning 曾被误报成错误导致会话假死）。
- **每会话独立 store**：`useChatSession` 的消息按 session_id 路由到模块级 store，前台/后台同一条写入路径；禁止「切换会话时拷贝缓存」的写法（曾导致跨会话数据污染）。
- **release 打包**：`tauri.conf.json` resources 带上 `agent-sidecar/sidecar.js`（esbuild 全量 bundle）+ `claude.exe`（SDK 平台包里的原生 CLI，运行时经 `AIDE_CLAUDE_EXE` → `pathToClaudeCodeExecutable` 传给 SDK）。目前资源路径是 win32-x64 的，其他平台发布时需按平台调整。运行环境需要系统 Node ≥ 18（或设 `AIDE_NODE_PATH`）。
- **插件市场 + Agent SDK 加载语义**：Claude 专属产物收拢在 `~/.claude-code-desktop/claude-agent-sdk/` 命名空间下（为后续接入其他 agent 打底——每个 agent 各占一个同级子目录）。Aide 把插件装在 `claude-agent-sdk/plugins/cache/<市场>/<插件>/<版本>/`（`plugins_dir()` = `claude_agent_sdk_dir()/plugins`，**不是** CLI 的 `~/.claude/plugins/`），Rust `write_enabled_plugins_manifest()` 写 `claude-agent-sdk/enabled-plugins.json`，sidecar env `AIDE_ENABLED_PLUGINS_FILE`（dunce::simplified）→ Node `buildPluginsOption()`（每次 `query()` 重读）→ `options.plugins=[{type:"local",path}]`。已装插件「启用」判定：`enabledPlugins` 映射键不存在 = 启用（与安装默认启用对齐），仅显式 `false` = 禁用（`plugin_enabled()` 单一判定，list 与 manifest 共用）。**关键事实：Agent SDK 的 `options.plugins` 只加载显式传入的本地路径，`type:"local"` 是唯一接受值；SDK 不自动扫描 `~/.claude/plugins/`、不读 CLI 的 `installed_plugins.json`**——故 Aide 装在哪都行、无双加载。`settingSources`/`skills:"all"` 只加载散装 skills/settings，不加载 plugin 包。完整官方文档见 [docs/reference/agent-sdk-plugins.md](docs/reference/agent-sdk-plugins.md)，设计见 [docs/superpowers/specs/2026-07-13-marketplace-extension-design.md](docs/superpowers/specs/2026-07-13-marketplace-extension-design.md)。
- **/btw 支线子对话（顺便问一下）**：发送按钮下拉切「顺便问一下」→ fork 主会话当前状态开独立 sidecar 进程（`start_btw_session` → `send` 带 `btw:true`+`session_id=<主sid>` → SDK `forkSession:true`+`persistSession:false`）。独立 `useBtwSession` store、右侧浮层 `BtwDrawer`（不挤占主对话）、事件按 session_id 路由隔离（`useChatSession.handleChatEvent` 最先 `isBtwSid` 拦截，早于 resolveSid）。跑完结论以 `ActionBlock(actionId:'btw',foldable)` 页边批注回插主对话（前端可见、不进 SDK resume 上下文——批注只在 `store.messages`，主对话 `send` 发的是 `sendText` 纯文本，sidecar resume 只读 JSONL，批注不在 JSONL 里）。默认轻量（`tools:[]` 禁工具省 token），可切完整（继承主工具集 `allowedTools:["Agent","Task"]`）。一次性：发送后自动切回主对话输入（回弹视觉 `btw-revert-flash` + toast）。阅后即弃：不落盘、不能重开、单实例（`startBtw` 先 cleanup 旧的）。Claude 专属（forkSession/persistSession/tools）只落 `agent-sidecar/`（`btwOptions.ts`），Rust/前端走 `btw:true` 中性标记，不感知 forkSession。设计见 [docs/superpowers/specs/2026-07-15-btw-side-conversation-design.md](docs/superpowers/specs/2026-07-15-btw-side-conversation-design.md)，实现见 [docs/superpowers/plans/2026-07-15-btw-side-conversation.md](docs/superpowers/plans/2026-07-15-btw-side-conversation.md)。
