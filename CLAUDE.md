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
| 样式 | Tailwind CSS 3 + Catppuccin 暗色主题，全项目三角箭头统一 `font-size: 14px` |
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

## 项目结构

```
aide/
├── dev.ps1 / dev.sh            # 一键启动（PowerShell / Git Bash）
├── src/
│   ├── App.vue                 # 三栏布局 + 标题栏 + 右面板 Tab（文件/Git）+ 工作区桥接
│   ├── components/
│   │   ├── SidebarLeft.vue     # 会话列表 + 功能区
│   │   ├── ChatPanel.vue       # Chat 主界面（消息流 + 输入区 + skills 补全 + 停止按钮）
│   │   ├── ChatMessage.vue     # 单条消息渲染（Markdown + 工具卡片 + 图片 + 路径点击跳转）
│   │   ├── ToolCallBlock.vue   # 工具调用卡片（可折叠）/ BashOutputBlock.vue（xterm 只读输出）
│   │   ├── PermissionDialog.vue # 工具权限确认弹窗
│   │   ├── WorkbenchTerminal.vue # 工作台 shell 终端（xterm + shell.rs PTY）
│   │   ├── FileTree.vue        # 文件树（懒加载递归）
│   │   ├── ChangeLogPanel.vue  # 会话变更面板（轮次分组 + 撤回）
│   │   ├── GitPanel.vue        # Git 看板（分支/变更/提交历史/diff）
│   │   ├── ContextMenu.vue     # 全局右键菜单（Teleport to body）
│   │   ├── ModalDialog.vue     # 通用弹窗
│   │   ├── SettingsPanel.vue   # 设置弹窗（通用/扩展/市场，680×520px）
│   │   ├── FileViewer.vue      # 文件窗口管理层（多窗口平铺/聚焦，子实现在 fileviewer/FileWindow.vue）
│   │   ├── titlebar/           # TitleBar / SearchBox / WindowControls
│   │   ├── customizations/     # CustomizationList / Detail / Panel
│   │   └── marketplace/        # MarketplaceTab / PluginCard
│   ├── composables/
│   │   ├── useChatSession.ts      # 对话核心（每会话独立 store + 事件路由 + resume + ID 迁移）
│   │   ├── useSessionState.ts     # 会话运行状态（模块级 reactive 单例）
│   │   ├── useConversationChanges.ts # 变更追踪（轮次分组 + 撤回）
│   │   ├── useGit.ts              # Git 状态（模块级单例）
│   │   ├── useSettings.ts         # 设置（模块级 reactive 单例）
│   │   ├── useFileViewer.ts       # 文件窗口状态层（多窗口，默认可编辑，md 三态）
│   │   ├── useContextMenu.ts      # 右键菜单状态层
│   │   ├── useModal.ts            # 弹窗状态层
│   │   ├── useWindowFocus.ts      # 窗口焦点跟踪
│   │   ├── useNotification.ts     # 桌面通知（watch 状态转换）
│   │   ├── useCustomizations.ts   # 扩展 CRUD + toggle
│   │   ├── useMarketplace.ts      # 插件市场
│   │   ├── useSearchProviders.ts  # 标题栏搜索源注册表
│   │   └── useWindowControls.ts   # 窗口操作封装
│   ├── utils/
│   │   ├── highlight.ts        # hljs 初始化 + extToLang + highlightCode()
│   │   ├── markdown.ts         # marked 初始化 + escapeHtml()
│   │   ├── errors.ts           # Git 错误解析（Rust CODE → 用户消息）
│   │   └── shortcut.ts         # 快捷键解析/匹配/冲突检测
│   ├── api.ts                  # Tauri invoke 类型安全封装层
│   ├── types.ts                # 集中类型定义
│   ├── types/                  # customization + marketplace 类型
│   ├── api/                    # customization / marketplace / git API
│   └── menus/contextMenus.ts   # 右键菜单配置（工厂函数）
├── agent-sidecar/              # Node.js sidecar：Claude Agent SDK 调用（Claude 专属逻辑只能在这）
│   └── src/                    # index.ts（stdin/stdout JSON lines）/ mapper / permissions / generator
├── src-tauri/src/
│   ├── lib.rs                  # Tauri Builder：注册 state + commands
│   ├── sidecar.rs              # sidecar 进程管理（spawn/send/kill/rename + 事件转发）
│   ├── shell.rs                # 工作台终端 PTY
│   └── commands/
│       ├── chat.rs             # send_message / permission_response / interrupt / stop
│       ├── filesystem.rs / git.rs
│       ├── session.rs / workspace.rs / settings.rs
│       ├── customizations.rs   # 25 命令，5 种类型 × CRUD+toggle
│       └── marketplace.rs      # fetch/install/uninstall/list-installed
└── PLANS.md                    # 产品待办清单
```

## 关键约定

- **非 scoped 样式**：xterm 动态 DOM（`WorkbenchTerminal.vue`、`BashOutputBlock.vue`）的样式必须放非 scoped `<style>` 块，否则 Vite scoped hash 导致样式不生效。
- **通知不依赖插件**：直接用 `notify-rust`（`notify_send` 命令），强制 `app_id("com.aide.app")`，绕过 tauri-plugin-notification dev 模式跳过 app_id 的 bug。
- **会话 ID 生命周期（延迟创建）**：点"新建会话"只清空 `activeSessionId`，打开空白面板，不落盘、不进侧栏。首次发消息时若无 session id，`useChatSession.ts` 现场生成一个纯内存临时 key（`crypto.randomUUID()`，记入 `pendingSids`），不落盘直接调 `send_message`。SDK 首次 `session_init` 带回真实 id 后才是"创建"真正发生的时刻：Rust `rename_sidecar_session` 原地改 sidecar 进程注册表（内存操作，无 IO），前端 `finalizeSession` 原地搬迁 `stores`/`sessionState`，随后 `onSessionCreated` 回调里 App.vue 才第一次调 `create_session(id, name)` 写元数据、`addSession` 加侧栏、`recordCurrentSession` 记最近访问。此后 aide ID 永远等于 SDK session ID，不再改名。历史会话续接：resume 直接用 `sid` 本身（`isPendingSession(sid) ? undefined : sid`），无需任何映射表。若发消息后从未等到 `session_init`（进程崩溃等），什么都不落盘，不留孤儿文件。
- **状态语义**：`running`（生成中）/ `attention`（等权限确认）/ `waiting`（sidecar 存活空闲，message_stop 后）/ `stopped`（进程不在）。通知、任务栏进度、变更捕获都依赖 `running→waiting` 转换，不要把 message_stop 改成 stopped。
- **stderr 不是错误**：sidecar stderr 只进日志与 8 行尾部缓冲，仅进程意外退出时才发一条 error 事件（Node warning 曾被误报成错误导致会话假死）。
- **每会话独立 store**：`useChatSession` 的消息按 session_id 路由到模块级 store，前台/后台同一条写入路径；禁止「切换会话时拷贝缓存」的写法（曾导致跨会话数据污染）。
- **release 打包**：`tauri.conf.json` resources 带上 `agent-sidecar/sidecar.js`（esbuild 全量 bundle）+ `claude.exe`（SDK 平台包里的原生 CLI，运行时经 `AIDE_CLAUDE_EXE` → `pathToClaudeCodeExecutable` 传给 SDK）。目前资源路径是 win32-x64 的，其他平台发布时需按平台调整。运行环境需要系统 Node ≥ 18（或设 `AIDE_NODE_PATH`）。
