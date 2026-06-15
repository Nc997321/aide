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
│   ├── App.vue                 # 三栏布局 + 可拖拽分隔 + Ctrl+N + 桥接会话 + ContextMenu
│   ├── components/
│   │   ├── SidebarLeft.vue     # 左侧：会话列表 + 自定义功能区
│   │   ├── TerminalPanel.vue   # 中间：全屏 xterm.js 终端（主交互区）
│   │   ├── FileTree.vue        # 右侧：路径栏 + 文件树（懒加载递归）
│   │   ├── TreeNodeItem.vue    # 文件树递归节点（独立 SFC，构建时编译）
│   │   ├── ContextMenu.vue     # 全局右键菜单组件（Teleport to body）
│   │   ├── ModalDialog.vue     # 通用弹窗（确认/输入）
│   │   └── FileViewer.vue      # 文件查看器弹窗（highlight.js 语法高亮 + marked Markdown 渲染）
│   ├── composables/
│   │   ├── useContextMenu.ts   # 右键菜单状态层（模块级 ref 单例）
│   │   ├── useSessionState.ts  # 会话运行状态（模块级 reactive 单例）
│   │   ├── useModal.ts         # 弹窗状态层
│   │   └── useFileViewer.ts    # 文件查看器状态层（模块级 ref 单例）
│   ├── menus/
│   │   └── contextMenus.ts     # 右键菜单配置层（工厂函数，与组件解耦）
│   └── styles/global.css       # 暗色主题 CSS 变量 + 滚动条 + 菜单动画
├── src-tauri/
│   ├── Cargo.toml              # tauri, portable-pty, serde, serde_json
│   ├── tauri.conf.json         # 窗口 1400x900，devUrl :1420
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs             # 入口 → lib::run()
│       ├── lib.rs              # Tauri Builder：注册 state + commands
│       ├── commands.rs         # Tauri commands + Claude Code 适配层
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
用户键盘 → live terminal.onData → invoke("pty_write", {sessionId: ptyId})
  → Rust PtyManager.write(ptyId) → PTY stdin → claude 进程
    → claude stdout → PTY reader thread
      → emit("pty-output", {session_id: ptyId, data})
        → liveSessions.get(ptyId).terminal.write(data)   ← 直达，无过滤
```

### 会话状态指示器

侧栏每条会话有四种状态，通过 `useSessionState`（模块级 `reactive` 单例）在组件间共享：

| 状态 | 侧栏显示 | 触发条件 |
|------|---------|----------|
| `stopped` | 无标识 | 默认（PTY 不存在） |
| `running` | 绿色光带从右到左扫过 | 用户按 Enter 发消息 |
| `waiting` | 右侧绿色边框 | `.jsonl` 最后事件为 `assistant`（Claude 完成） |
| `attention` | 琥珀色光带扫过 | 终端出现权限审批提示 `[y/n]` |

**判定逻辑**（`TerminalPanel.vue`）：
- 进入实时模式 → 默认 `waiting`
- 用户按 Enter → 立即 `running`
- 每 2 秒周期查 `session_last_event` → `assistant` 则 `waiting`
- 权限关键词 → `attention`

### PTY 管理（Rust 侧不变）

PtyManager 维护 `HashMap<String, PtySession>`，每个会话独立持有 PTY。切换会话时不杀进程，只切换终端显隐。

### 前端状态（TerminalPanel.vue）

| 变量 | 类型 | 说明 |
|------|------|------|
| `liveSessions` | `Map<ptyId, LiveSession>` | 直播终端表，key 是 PTY 侧 session ID |
| `ptyToDisplay` | `Map<ptyId, displayId>` | `new_xxx` → 真实 UUID 的迁移映射 |
| `liveDisplayIds` | `reactive Set<displayId>` | 给模板用，驱动关闭按钮显隐 |
| `periodicTimers` | `Map<ptyId, setInterval>` | 每 2 秒轮询 `.jsonl` 状态 |
| `props.sessionId` | 外部传入 | 当前该显示哪个会话（唯一真相源，无 `activeSid`） |

**切换流程**：
```
watch(sessionId) → showSession(sid)
  ├─ liveSessions 有 → 显示对应 div，fit()
  └─ 没有 → 显示预览终端，渲染历史
```

**新建会话 ID 迁移**（不在 watch 里）：
`startClaude()` 用 placeholder `new_xxx` 创建 PTY → 3 秒后 `scheduleMigration()` 拉会话列表找到真实 UUID → 更新 `ptyToDisplay` + Rust `pty_rename_session` → 再 emit `session-updated` 刷新侧栏。

**PTY reader 线程遗留问题**：Rust reader 线程闭包里捕获了旧 session ID（如 `new_xxx`），迁移后仍用旧 ID 发 `pty-output` 事件。`ptyToDisplay` 映射解决此问题——`showSession` 通过映射找到真正的 PTY key 来定位 live terminal。而 pty-output 监听直接 `liveSessions.get(p.session_id)` 拿到终端，无需 ID 转换。

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

### 右键菜单系统（4 层）

```
展示层  ContextMenu.vue     Teleport + Transition + 边界检测
状态层  useContextMenu.ts   模块级 ref 单例
配置层  contextMenus.ts     工厂函数，与组件解耦
接入层  各组件 @contextmenu  handler
```

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
| `delete_file` | `path` | 删除文件或目录 |
| `create_file` | `parent_path, name` | 新建空文件 |
| `create_dir` | `parent_path, name` | 新建目录 |
| `git_diff_files` | — | 执行 `git status --porcelain`，返回 `[{path, status}]`，用于文件树"更改"tab |

### 会话持久化

| 命令 | 说明 |
|------|------|
| `list_sessions` | 扫描 `~/.claude/projects/<encoded>/*.jsonl` + sessions 元数据 + 我们元数据 |
| `load_messages` | 解析 `.jsonl`，提取 user/assistant 文本（用于终端预览） |
| `create_session` | placeholder `new_<timestamp>`，真实 session 由 Claude 创建 |
| `delete_session` | 删 `.jsonl` + pid JSON + 我们元数据 |
| `rename_session` | 更新我们元数据的 displayName |
| `session_last_event` | 读 `.jsonl` 最后一行，返回事件 type（`user`/`assistant`/`system`），用于判断 Claude 是否完成 |
| `list_workspaces` | 扫描 `~/.claude/projects/` 目录，返回 `[{key, name}]`，key 是 encoded 目录名，name 通过 DFS 文件系统搜索解析的真实路径 |
| `set_workspace` | 设置当前工作区，`{key, path}` 分别存 key（用于查会话）和 path（用于文件操作） |

## 前端组件要点

### App.vue
- 三栏 `flex` 布局 + 可拖拽分隔条（3px，hover 高亮）
- `activeSessionId` ref 桥接 SidebarLeft ↔ TerminalPanel
- `Ctrl+N` → `SidebarLeft.newSession()`
- 监听 `session-updated` → 重新加载会话列表
- **工作区切换**：监听 SidebarLeft 和 FileTree 的 `workspace-changed`，emit 链驱动另一端刷新
- 面板宽度限制：左 200-450px，右 200-500px，中 min 400px

### TerminalPanel.vue（核心）
- **多终端架构**：1 个预览终端（共享）+ N 个直播终端（每 PTY 一个独立 xterm 实例）
- **DOM 布局**：`.terminal-stack`（flex:1, position:relative）→ 所有 `.terminal-container`（absolute inset:0），display none 切换
- **数据流**：每个直播 terminal 的 `onData` 绑定自己的 `ptyId`；`pty-output` 监听直接 `liveSessions.get(p.session_id).terminal.write(data)`，无需 session ID 过滤
- **状态**：`liveSessions: Map<ptyId, LiveSession>`（真相源）、`ptyToDisplay: Map<ptyId, displayId>`（迁移映射）、`liveDisplayIds: reactive Set`（模板驱动）
- **切换**：`showSession(sid)` → 隐藏全部 div → 找到对应 live terminal 或显示预览
- **新建会话迁移**：`startClaude()` 用 `new_xxx` 创建 PTY → 3 秒后 `scheduleMigration()` 拉列表找真实 UUID → 更新 `ptyToDisplay` + `pty_rename_session` → emit `session-updated`
- **预览模式**：共享预览终端展示 `load_messages` 历史，Enter 键触发 `startClaude()`
- **关闭按钮**：⏹ 停止当前 Claude（`destroyLiveSession` 清理 DOM + terminal + observer）
- **自适应**：每个终端独立 FitAddon + ResizeObserver → `pty_resize`
- **注意**：动态创建的 DOM 元素不受 Vue scoped CSS 影响，terminal 相关样式放在非 scoped `<style>` 块

### SidebarLeft.vue
- **工作区列表**：`list_workspaces` 加载全部工作区，活动工作区展开显示其会话，`▸` 三角旋转 90° 表示展开
- 点击其他工作区 → `set_workspace({key, path})` → 加载会话 + emit `workspace-changed` 通知 FileTree 刷新
- 会话列表从 `list_sessions` 加载，按时间戳倒序
- 空列表时自动创建首个会话；`activeSessionId` 为 `new_` 时自动选真实会话
- 相对时间显示（分钟前/小时前/天前）
- **会话状态指示器**：通过 `useSessionState` 读取状态，渲染三种效果（绿色扫光 = running，右侧绿边 = waiting，琥珀色扫光 = attention）
- 自定义功能区（智能体/技能等，仅展示名称）
- 右键菜单：重命名 / 删除
- `defineExpose({ newSession, loadSessions })`

### FileTree.vue
- 路径栏 `📁 root · branch`，rtl 省略
- **Tab 栏**：文件 / 更改 — 切换文件树和 git diff 视图
- 懒加载子目录（`list_directory`）
- **左键点击文件** → 内置查看器 `FileViewer`（语法高亮 + Markdown 渲染）
- **更改 tab**：调用 `git_diff_files` 列出 modified/added/deleted 文件，点击在 FileViewer 中打开
- **右键菜单**：查看 / 其他方式打开（系统默认程序）/ 复制路径 / 复制相对路径 / 删除
- 目录右键菜单：展开/折叠 / 复制路径 / 新建文件 / 新建文件夹 / 删除

### FileViewer.vue
- 模块级 `useFileViewer` 单例状态层（`open(path)` / `close()`）
- **代码文件**：highlight.js 语法高亮，12 种语言自动匹配，Catppuccin 配色
- **Markdown 文件**（`.md` / `.mdx`）：marked 渲染为排版 HTML（标题、表格、代码块语法高亮等）
- 弹窗 90vw / 900px 宽，85vh 高，Esc 关闭
- `read_file_content` 读文件，二进制/不可读文件显示错误

## 当前状态

### 已实现
- 三栏可拖拽布局 + Catppuccin 暗色主题
- **全屏 xterm.js 终端** — 多会话 PTY，完整 Claude 交互
- **多会话并行存活** — 切换 instant，不杀进程
- **会话状态指示器** — 侧栏显示会话运行状态（running/waiting/attention），通过 `.jsonl` 事件类型判断
- **会话预览** — 无 PTY 时展示 Markdown 渲染历史，按 Enter 或点击启动（HTML div + window 级键盘拦截）
- 会话管理 — 适配 `~/.claude/` 真实存储（列表/创建/删除/重命名）
- 工作区管理（`list_workspaces` / `set_workspace`）
- 文件树（懒加载，新建/删除文件目录，**"更改"tab 显示 git diff 文件列表**）
- 右键菜单（4 层架构，文件/目录/树空白/会话）
- **文件查看器** — 左键点击内置查看，highlight.js 语法高亮 + marked .md 渲染，右键"其他方式打开"调系统程序
- Ctrl+N 新建会话
- **窗口状态记忆** — `tauri-plugin-window-state` 自动保存/恢复窗口位置和大小

### 未实现 / 待改进
- 自定义功能区读真实配置
- 会话搜索
- 窗口状态记忆
- 文件树的 "更改" tab（git diff）
