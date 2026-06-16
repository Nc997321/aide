# CLAUDE.md — Aide

非官方桌面应用，用 Tauri v2 + Vue 3 为 Claude Code CLI 提供带会话管理和文件树的终端桌面壳。

## 技术栈

| 层 | 技术 |
|---|------|
| 桌面框架 | Tauri v2 (Rust 后端 + WebView 前端) |
| 前端 | Vue 3 + Composition API + TypeScript |
| 终端 | xterm.js 5.x + xterm-addon-fit |
| 代码高亮 | highlight.js 11.x（仅打包 12 种语言） |
| Markdown 渲染 | marked 18.x（文件查看器 .md 预览） |
| 样式 | Tailwind CSS 3 + Catppuccin 暗色主题 |
| 包管理 | pnpm |
| Rust 编译 | MSVC 工具链（VS Build Tools 2022） |

## 项目结构

```
aide/
├── dev.ps1                     # PowerShell 一键启动
├── dev.sh                      # Git Bash 一键启动
├── src/
│   ├── main.ts                 # Vue 入口
│   ├── App.vue                 # 三栏布局 + 右面板纵向拆分 + 可拖拽分隔 + Ctrl+N + 桥接会话
│   ├── components/
│   │   ├── SidebarLeft.vue     # 左侧：会话列表 + 自定义功能区
│   │   ├── TerminalPanel.vue   # 中间：全屏 xterm.js 终端（主交互区）
│   │   ├── FileTree.vue        # 右侧上部：路径栏 + 文件树（懒加载递归）
│   │   ├── ChangeLogPanel.vue  # 右侧下部：会话变更面板（可折叠 + 轮次分组 + 撤回）
│   │   ├── TreeNodeItem.vue    # 文件树递归节点（独立 SFC，构建时编译）
│   │   ├── ContextMenu.vue     # 全局右键菜单组件（Teleport to body）
│   │   ├── ModalDialog.vue     # 通用弹窗（确认/输入）
│   │   ├── SettingsModal.vue    # 设置弹窗（字号/字体/通知开关，即时生效）
│   │   └── FileViewer.vue      # 文件查看器弹窗（语法高亮 + Markdown 渲染 + 编辑模式）
│   ├── composables/
│   │   ├── useContextMenu.ts   # 右键菜单状态层（模块级 ref 单例）
│   │   ├── useSessionState.ts  # 会话运行状态（模块级 reactive 单例）
│   │   ├── useSessionMonitor.ts # 会话状态监测 + `checking` Set 防 async 竞态
│   │   ├── useTerminalManager.ts # 终端实例生命周期（liveSessions + PTY I/O + 迁移 + 显隐切换）
│   │   ├── useModal.ts         # 弹窗状态层
│   │   ├── useFileViewer.ts    # 文件查看器状态层（模块级 ref 单例）
│   │   ├── useConversationChanges.ts  # 会话变更追踪（按轮次分组 + 撤回）
│   │   ├── useSettings.ts      # 设置状态层（模块级 reactive 单例 + load/update）
│   │   ├── useWindowFocus.ts   # 窗口焦点跟踪（onFocusChanged）
│   │   └── useNotification.ts  # 桌面通知触发（watch sessionState 转换）
│   ├── utils/
│   │   ├── highlight.ts        # 共享 hljs 初始化 + extToLang + highlightCode()
│   │   └── markdown.ts         # 共享 marked 初始化 + escapeHtml()
│   ├── types.ts                # 集中类型定义（Session, FileEntry, DiffEntry, LastEventInfo 等）
│   ├── api.ts                  # Tauri invoke 类型安全封装层
│   ├── menus/
│   │   └── contextMenus.ts     # 右键菜单配置层（工厂函数，与组件解耦）
│   └── styles/global.css       # 暗色主题 CSS 变量 + 滚动条 + 菜单动画
├── src-tauri/
│   ├── Cargo.toml              # tauri, portable-pty, serde, notify-rust
│   ├── tauri.conf.json         # 窗口 1400x900，devUrl :1420
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs             # 入口 → lib::run()
│       ├── lib.rs              # Tauri Builder：注册 state + commands
│       ├── commands/
│       │   ├── mod.rs          # 共享类型 + 辅助函数 + re-export
│       │   ├── pty.rs          # PTY 相关 commands
│       │   ├── filesystem.rs   # 文件系统 commands
│       │   ├── git.rs          # Git 相关 commands
│       │   ├── session.rs      # 会话持久化 commands
│       │   ├── workspace.rs    # 工作区 commands
│       │   └── settings.rs     # 设置 commands + notify_send（绕过插件 dev 限制）
│       └── pty.rs              # 多会话 PTY 管理器（HashMap<sessionId, PtySession>）
├── package.json
├── vite.config.ts
└── PLANS.md                    # 产品待办清单
```

## 核心架构

### 交互模型：全屏终端

中心面板为 xterm.js 终端，通过 PTY 直接运行 Claude Code 交互模式（不带 `-p`）。**不再使用聊天气泡**——终端内 Claude 的 TUI 原样渲染，权限审批、工具使用均为原生体验。

### 多终端架构（多例，非单例）

**预览终端**（单例）：所有无 PTY 的会话共用同一个 xterm 实例，展示静态历史文本。`props.sessionId` 切换时清屏重新渲染。

**直播终端**（多例）：每个启动 Claude 的会话各自持有独立的 xterm 实例 + DOM div。互不干扰，各自保留滚动缓冲区。

```
.live terminal A              .live terminal B
  div.terminal-container        div.terminal-container
    xterm.open()                  xterm.open()
    onData → pty_write(A)        onData → pty_write(B)
    ← pty-output[A]              ← pty-output[B]
```

两个终端 div 都放在 `.terminal-stack` wrapper 内，通过 `display: none` 切显隐。`position: absolute; inset: 0` 撑满 wrapper。

### 数据流

```
用户键盘 → live terminal.onData → api.ptyWrite(ptyId, data)
  → Rust PtyManager.write(ptyId) → PTY stdin → claude 进程
    → claude stdout → PTY reader thread (I/O)
      → emit("pty-output", {session_id: ptyId, data})
        → liveSessions.get(ptyId).terminal.write(data)   ← 直达，无过滤

进程退出检测（独立 waiter 线程）：
  Rust child.wait() 阻塞 → 进程退出 → HashMap 清理
    → emit("pty-exit", {session_id})
      → initExitListener → stopClaude() → destroyLiveSession()
        → showSession() → 预览模式
```

### 会话状态指示器

侧栏每条会话有四种状态，通过 `useSessionState`（模块级 `reactive` 单例）在组件间共享：

| 状态 | 侧栏显示 | 触发条件 |
|------|---------|----------|
| `stopped` | 无标识 | 默认（PTY 不存在） |
| `running` | 绿色光带从右到左扫过 | 用户按 Enter 发消息 |
| `waiting` | 右侧绿色边框 | `.jsonl` 最后事件为 `assistant` 且 `stop_reason === "end_turn"`（Claude 真正完成，排除中间 tool_use） |
| `attention` | 琥珀色光带扫过 | 终端出现权限审批提示 `[y/n]` |

**判定逻辑**（`useSessionMonitor.ts`）：
- 进入实时模式 → 默认 `waiting`
- 用户按 Enter → 立即 `running`
- 每 2 秒周期查 `session_last_event` → 返回 `{ event_type, stop_reason }`，`assistant` + `end_turn` 才置 `waiting`（避免 tool_use 中间态误判）
- 权限关键词 → `attention`

### PTY 管理（Rust 侧）

PtyManager 维护 `HashMap<String, PtySession>`，每个会话独立持有 PTY。切换会话时不杀进程，只切换终端显隐。

**双线程模型**：
- **reader 线程**：纯 I/O 转发，`read()` 循环 → `emit("pty-output", ...)`，EOF/error 时退出
- **waiter 线程**：`child.wait()` 阻塞等待进程退出 → 可靠检测 Ctrl+D 退出 → 清理 HashMap → `emit("pty-exit", ...)`。reader 线程的 EOF 检测不可靠（PTY 不保证在子进程退出时关闭管道），waiter 线程才是退出检测的权威来源

### 前端状态

| 变量 | 所属模块 | 说明 |
|------|---------|------|
| `liveSessions` | `useTerminalManager` | 直播终端表，key 是 PTY 侧 session ID |
| `ptyToDisplay` | `useTerminalManager` | `new_xxx` → 真实 UUID 的迁移映射 |
| `liveDisplayIds` | `useTerminalManager` | reactive Set，驱动关闭按钮显隐 |
| `periodicTimers` | `useSessionMonitor` | 每 2 秒轮询 `.jsonl` 状态 |
| `checking` | `useSessionMonitor` | Set 互斥锁，防止 async 轮询竞态 |
| `settings` | `useSettings` | 模块级 reactive 单例，字号/字体/通知开关 |
| `isFocused` | `useWindowFocus` | 模块级 ref，窗口焦点状态 |
| `props.sessionId` | TerminalPanel | 当前该显示哪个会话（唯一真相源） |

**切换流程**：
```
watch(sessionId) → showSession(sid) + loadPreviewContent(sid)
  ├─ liveSessions 有 PTY → 显示对应 div，fit()
  └─ 没有 PTY → 显示 HTML 预览 div + 加载消息历史
```

**新建会话 ID 迁移**（不在 watch 里）：
`startClaude()` 用 placeholder `new_xxx` 创建 PTY → 3 秒后 `scheduleMigration()` 调 `find_recent_session` 扫描 `~/.claude/sessions/<pid>.json`（按 cwd 匹配项目，取 `startedAt` 最新的）找到真实 UUID → 更新 `ptyToDisplay` 映射 → emit `session-updated` 刷新侧栏。不依赖 `.jsonl`（对话才有），元数据文件启动即创建。

**为什么不能调 `pty_rename_session`**：`startClaude()` 中 `terminal.onData` 和 `ResizeObserver` 的闭包捕获了 placeholder ID → 所有 `ptyWrite`/`ptyResize` 都用 `new_xxx` 发到 Rust。如果在 Rust 侧把 HashMap key 从 `new_xxx` 改成真实 UUID，前端闭包发出的旧 key 就找不到 PTY 了——输入和 resize 全部静默失败（TUI 无法操作）。

**PTY reader 线程**：Rust reader 线程闭包里捕获了 placeholder ID（如 `new_xxx`），一直用此 ID 发 `pty-output` 事件——这没问题，因为 Rust HashMap key 没改。`pty-output` 监听直接 `liveSessions.get(p.session_id)` 拿到终端，`showSession` 通过 `ptyToDisplay` 映射从真实 UUID 找到 PTY key（placeholder）。

### 会话系统 — 适配 Claude Code 存储

Rust 侧作为适配层读取 Claude Code 的真实存储：

```
~/.claude/
├── sessions/<pid>.json          {pid, sessionId, cwd, name, startedAt, kind}
└── projects/<encoded-cwd>/
    └── <sessionId>.jsonl        每行 JSON event (type: user/assistant/system/...)
```

路径编码: `C:\path\to\project` → `C--path-to-project`（`:` 和 `\` → `-`）

我们自己的元数据: `~/.claude-code-desktop/sessions/<sessionId>.json` — 只存 displayName，sessionId 直接使用 Claude Code 的 UUID。

### 工作区系统

`WorkspaceState` 存两个字段：
- `key`：encoded 目录名（如 `C--document-owner-cypress-agent`），唯一标识，用于定位 `~/.claude/projects/<key>/` 下的会话
- `path`：真实文件系统路径（如 `C:\document\owner\cypress-agent`），用于文件树、PTY cwd 等文件操作

路径解析（`resolve_path_from_key`）：DFS 搜索文件系统，对每个 `-` 尝试分隔符或字面量的解读，找到磁盘上存在的路径。解决了编码有损（路径含 `-` 时无法区分）的问题。

持久化：`set_workspace` 时 key 写到 `~/.claude-code-desktop/config.json`，启动时读回。

### 设置系统

`~/.claude-code-desktop/config.json` 现在存两个顶层字段：
```json
{ "workspace": "C-Users-...", "settings": { "font_size": 14, ... } }
```

**Rust 侧**：`settings.rs` 提供 `load_config()` / `save_config()` 作为全文件 JSON 读写 helper。`workspace.rs` 重构为使用这些 helper，不再覆盖 settings 字段。`get_settings` / `set_settings` 命令用默认值填充缺失字段。

**前端侧**：`useSettings` 模块级 reactive 单例。`SettingsModal` v-model 绑定本地 ref，watch 同步到 settings + 调 `update()` 持久化。`useTerminalManager` watch `settings.fontSize`/`fontFamily`，遍历 `liveSessions` 即时应用到所有终端。

### 桌面通知

**不依赖 `tauri-plugin-notification`**——该插件在桌面端只是 `notify-rust` 的薄封装，且 dev 模式下故意跳过 `app_id`（检查 exe 路径是否含 `target\debug` 或 `target\release`）。

我们自己的 `notify_send` 命令直接用 `notify-rust`：
```rust
n.app_id("com.aide.app");  // 强制设，不论 dev/prod
n.auto_icon();
n.summary(&title).body(&body).show();
```

**触发链**：
```
useSessionMonitor.checkSessionState() 检测到 end_turn
  → setSessionState(id, "waiting")
    → useNotification watch 触发
      → 检查 loaded && notificationsEnabled && !isFocused
        → api.notifySend(项目名, "会话名 已回复")
```

**防重复**：`useSessionMonitor.checkSessionState` 是 async 函数，`await api.sessionLastEvent()` 会让出。`checking` Set 作为互斥锁——同一会话同一时刻只有一个 check 在执行，防止两个轮询 tick 同时通过 `cur !== "waiting"` 检查后都设 "waiting"。`finally` 释放锁。

**窗口焦点**：`useWindowFocus` 通过 `getCurrentWindow().onFocusChanged` 跟踪，初始化时主动调 `isFocused()` 补获当前状态。

## Tauri Commands

### 终端交互（PTY）

| 命令 | 参数 | 说明 |
|------|------|------|
| `pty_spawn_claude` | `rows, cols, session_id` | 通过 PTY 启动 `claude` 交互模式（`--resume <id>`） |
| `pty_write` | `session_id, data` | 键盘输入 → 指定会话的 PTY stdin |
| `pty_resize` | `session_id, rows, cols` | 窗口大小变化 → 同步 PTY 行列 |
| `pty_kill` | `session_id` | 关闭指定会话的 Claude 进程 |
| `pty_has_session` | `session_id` | 检查指定会话是否有活 PTY |
| `pty_rename_session` | `old_id, new_id` | `new_` → 真实 UUID 时迁移 HashMap key |

### 项目 & 文件系统

| 命令 | 参数 | 说明 |
|------|------|------|
| `get_project_info` | — | 返回 `{root, name, branch}`，自动检测项目根目录（`.git` > `package.json` > `Cargo.toml`） |
| `list_directory` | `path` | 文件/目录列表，过滤 `.`开头、`node_modules`、`target`、`dist` |
| `file_open` | `path` | 系统默认程序打开文件（Windows: `cmd /c start`） |
| `read_file_content` | `path` | 读文件内容 |
| `write_file_content` | `path, content` | 写入文件内容 |
| `delete_file` | `path` | 删除文件或目录 |
| `create_file` | `parent_path, name` | 新建空文件 |
| `create_dir` | `parent_path, name` | 新建目录 |
| `git_diff_files` | — | `git diff --numstat`，返回 `[{path, additions, deletions}]`，用于会话变更日志 |
| `git_stage_all` | — | `git add -A`，Claude 回复前打快照 |
| `git_revert_file` | `path` | `git checkout -- <path>`，撤回单个文件到快照状态 |

### 会话持久化

| 命令 | 说明 |
|------|------|
| `list_sessions` | 扫描 `~/.claude/projects/<encoded>/*.jsonl` + sessions 元数据 + 我们元数据 |
| `load_messages` | 解析 `.jsonl`，提取 user/assistant 文本（用于终端预览） |
| `create_session` | placeholder `new_<timestamp>`，真实 session 由 Claude 创建 |
| `delete_session` | 删 `.jsonl` + pid JSON + 我们元数据 |
| `rename_session` | 更新我们元数据的 displayName |
| `session_last_event` | 读 `.jsonl` 最后一行，返回 `LastEventInfo { event_type, stop_reason }`，用于判断 Claude 是否真正完成（end_turn vs tool_use） |
| `list_workspaces` | 扫描 `~/.claude/projects/` 目录，返回 `[{key, name}]`，key 是 encoded 目录名，name 通过 DFS 文件系统搜索解析的真实路径 |
| `set_workspace` | 设置当前工作区，`{key, path}` 分别存 key（用于查会话）和 path（用于文件操作） |
| `get_settings` | 读 `config.json` 中 `settings` 字段，缺失用默认值 |
| `set_settings` | 合并 partial settings 到 `config.json`，不覆盖 `workspace` |
| `notify_send` | 直接用 `notify-rust` 发系统通知，强制 `app_id("com.aide.app")` |

## 关键组件行为

### App.vue — 三栏拖拽布局 + 启动初始化
- 左 200-450px、右 200-500px、中 min 400px，3px 分隔条
- **右面板纵向拆分**：FileTree（`flex:1`）+ 拖拽条 + ChangeLogPanel（默认 220px）
- **变更面板折叠沉底**：`@collapse-changed` → `height: auto` → 拖拽条隐藏，FileTree 撑满
- **启动初始化**：`loadSettings()` → `initWindowFocus()` → `useNotification()`，顺序保证通知触发时设置已就绪
- 渲染 `SettingsModal`（v-if）和齿轮按钮 `@open-settings` 事件

### SidebarLeft — 会话列表 + 设置入口
- 底部齿轮图标 SVG 按钮 → `emit("open-settings")`

### TerminalPanel — 多终端 + 预览 + 加载
- **非 scoped 样式**：`terminal-container`、`xterm`、`session-loader` 等动态 DOM 的样式放在非 scoped `<style>` 块
- **加载动画 DOM** 由 `useTerminalManager.createLoadingOverlay()` 动态创建，样式在 TerminalPanel 的非 scoped CSS

### ChangeLogPanel — 折叠通知父组件
- `emit("collapse-changed", collapsed)` → App.vue 切换高度

### useTerminalManager — 终端生命周期 + 设置响应
- `createLoadingOverlay()` / `dismissLoader()` — 加载动画 DOM 管理
- `initExitListener()` — 监听 `pty-exit` → `stopClaude()` 回预览，与 ⏹ 按钮相同路径
- `LOADER_DISMISS_DELAY = 5000` — 首次 pty-output 后延迟 5s 再关 loader
- `makeTerminal()` 从 `useSettings().settings` 读字号/字体，非硬编码
- watch `settings.fontSize`/`fontFamily` → 遍历所有 liveSessions 即时更新 + `fitAddon.fit()`

### useConversationChanges — 变更追踪
- `waiting/stopped → running` → `git_stage_all` 快照
- `running → waiting` → `git_diff_files` 捕获变更 → 生成轮次

### FileViewer — 内置查看器
- 代码：highlight.js + Catppuccin 配色
- Markdown：marked 渲染
- 编辑模式：Ctrl+S 保存、ESC 取消
- 模块级 `useFileViewer` 单例 `open(path)` / `close()`
