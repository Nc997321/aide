# CLAUDE.md — Aide

非官方桌面应用，用 Tauri v2 + Vue 3 为 Claude Code CLI 提供带会话管理和文件树的终端桌面壳。

详细架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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

## 项目结构

```
aide/
├── dev.ps1 / dev.sh            # 一键启动（PowerShell / Git Bash）
├── src/
│   ├── App.vue                 # 三栏布局 + 标题栏 + 右面板 Tab（文件/Git）+ 工作区桥接
│   ├── components/
│   │   ├── SidebarLeft.vue     # 会话列表 + 功能区
│   │   ├── TerminalPanel.vue   # xterm.js 终端（直播多例 + 预览单例）
│   │   ├── FileTree.vue        # 文件树（懒加载递归）
│   │   ├── ChangeLogPanel.vue  # 会话变更面板（轮次分组 + 撤回）
│   │   ├── GitPanel.vue        # Git 看板（分支/变更/提交历史/diff）
│   │   ├── ContextMenu.vue     # 全局右键菜单（Teleport to body）
│   │   ├── ModalDialog.vue     # 通用弹窗
│   │   ├── SettingsPanel.vue   # 设置弹窗（通用/扩展/市场，680×520px）
│   │   ├── FileViewer.vue      # 文件查看器（高亮 + Markdown + 编辑）
│   │   ├── titlebar/           # TitleBar / SearchBox / WindowControls
│   │   ├── customizations/     # CustomizationList / Detail / Panel
│   │   └── marketplace/        # MarketplaceTab / PluginCard
│   ├── composables/
│   │   ├── useTerminalManager.ts  # 终端生命周期（liveSessions + PTY I/O + 迁移 + 显隐）
│   │   ├── useSessionMonitor.ts   # 会话状态检测（esc to interrupt 信号）
│   │   ├── useSessionState.ts     # 会话运行状态（模块级 reactive 单例）
│   │   ├── useConversationChanges.ts # 变更追踪（轮次分组 + 撤回）
│   │   ├── useGit.ts              # Git 状态（模块级单例）
│   │   ├── useSettings.ts         # 设置（模块级 reactive 单例）
│   │   ├── useFileViewer.ts       # 文件查看器状态层
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
├── src-tauri/src/
│   ├── lib.rs                  # Tauri Builder：注册 state + commands
│   ├── pty.rs                  # 多会话 PTY 管理器
│   └── commands/
│       ├── pty.rs / filesystem.rs / git.rs
│       ├── session.rs / workspace.rs / settings.rs
│       ├── customizations.rs   # 25 命令，5 种类型 × CRUD+toggle
│       └── marketplace.rs      # fetch/install/uninstall/list-installed
└── PLANS.md                    # 产品待办清单
```

## 关键约定

- **非 scoped 样式**：`TerminalPanel.vue` 中动态 DOM（`terminal-container`、`xterm`、`session-loader`）的样式必须放非 scoped `<style>` 块，否则 Vite scoped hash 导致样式不生效。
- **通知不依赖插件**：直接用 `notify-rust`（`notify_send` 命令），强制 `app_id("com.aide.app")`，绕过 tauri-plugin-notification dev 模式跳过 app_id 的 bug。
- **状态检测信号**：依赖终端尾部 `esc to interrupt` 文本判断 Claude 是否工作中；`>` 提示符常驻，不能用于状态判断。
- **PTY key 不能重命名**：`startClaude()` 闭包捕获了 placeholder ID（`new_xxx`），Rust 侧 HashMap key 必须始终保持 placeholder，通过 `ptyToDisplay` 映射到真实 UUID。
- **session ID 迁移**：新建会话用 `new_<timestamp>` 占位，3 秒后 `scheduleMigration()` 扫描找到真实 UUID，`onSessionUpdated` 用 `splice` 原地替换侧栏条目（不能直接 `loadSessions()`，Vue props 异步传播会导致 placeholder 被重新添加）。
