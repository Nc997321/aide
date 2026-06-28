# Aide — 架构详解

## 交互模型：全屏终端

中心面板为 xterm.js 终端，通过 PTY 直接运行 Claude Code 交互模式（不带 `-p`）。**不再使用聊天气泡**——终端内 Claude 的 TUI 原样渲染，权限审批、工具使用均为原生体验。

## 多终端架构

**预览终端**（单例）：所有无 PTY 的会话共用同一个 xterm 实例，展示静态历史文本。`props.sessionId` 切换时清屏重新渲染。

**直播终端**（多例）：每个启动 Claude 的会话各自持有独立的 xterm 实例 + DOM div。互不干扰，各自保留滚动缓冲区。两个终端 div 都放在 `.terminal-stack` wrapper 内，通过 `display: none` 切显隐。

```
.live terminal A              .live terminal B
  div.terminal-container        div.terminal-container
    xterm.open()                  xterm.open()
    onData → pty_write(A)        onData → pty_write(B)
    ← poll_pty_output(A)         ← poll_pty_output(B)
```

## 数据流

```
用户键盘 → live terminal.onData → api.ptyWrite(ptyId, data)
  → Rust PtyManager.write(ptyId) → PTY stdin → claude 进程
    → claude stdout → PTY reader thread
      → Arc<Mutex<String>> output_buffer
        ← 前端 setInterval(100ms) → api.pollPtyOutput(ptyId) 拉取
          → terminal.write(data)

进程退出检测：
  Rust child.wait() 阻塞 → 进程退出 → HashMap 清理
    → emit("pty-exit", {session_id})
      → initExitListener → stopClaude() → destroyLiveSession() → 预览模式
```

**拉取模式而非推送**：PTY 输出通过共享缓冲区 + 前端 100ms 轮询传递，不走 IPC 事件推送。避免大量输出（Plan mode、/compact）淹没 WebView 事件循环。唯一 IPC 推送是 `pty-exit`（低频且关键）。

## 会话状态指示器

四种状态，通过 `useSessionState`（模块级 `reactive` 单例）跨组件共享：

| 状态 | 侧栏显示 | 触发条件 |
|------|---------|----------|
| `stopped` | 无标识 | PTY 不存在 / 进程退出 / 被停止 |
| `running` | 绿色光带从右到左扫过 | 用户按 Enter / 终端出现 `esc to interrupt` |
| `waiting` | 右侧绿色边框 | 终端不再显示 `esc to interrupt` |
| `attention` | 琥珀色光带扫过 | 终端出现 `[y/n]` 权限审批提示 |

**核心信号：`esc to interrupt`**。Claude Code TUI 只在真正处理轮次时（思考/流式输出/调用工具）在底部显示此文本，轮次结束即消失。`>` 提示符是常驻的，无法用于判断完成。

**判定逻辑**（`useSessionMonitor.ts`，每 800ms 同步轮询终端尾部 30 行）：
1. 权限关键词 → `attention`
2. 命中 `esc to interrupt` → `running`，标记 `sawWorking`
3. 未命中（Claude 空闲）：
   - 若本轮 `sawWorking` → 连续 `IDLE_CONFIRM_TICKS`(2) 次才转 `waiting`（防瞬时空隙误判）
   - 若从未 `sawWorking` → 距上次 Enter 超过 `STARTUP_GRACE_MS`(2500ms) 才转 `waiting`（兼顾慢启动）
- 用户按 Enter → 立即 `running`，`recordEnter` 重置 `sawWorking`/`idleStreak`
- 进程退出 → `stopped`（`destroyLiveSession` 显式设置）

通知由状态转换驱动（`useNotification` watch `running/attention → waiting`）。空 Enter 不误发通知：用户按 Enter 时窗口必为聚焦态，`isFocused` 守卫拦截。

## PTY 管理（Rust 侧）

`PtyManager` 维护 `HashMap<String, PtySession>`，每个会话独立持有 PTY。切换会话时不杀进程，只切换终端显隐。

**双线程模型**：
- **reader 线程**：`read()` 循环 → 追加到 `Arc<Mutex<String>>` 共享缓冲区，前端通过 `poll_pty_output` 拉取并清空
- **waiter 线程**：`child.wait()` 阻塞等待进程退出 → 清理 HashMap → `emit("pty-exit")`。reader 的 EOF 检测不可靠（PTY 不保证子进程退出时关闭管道），waiter 才是退出检测的权威来源

## 前端状态

| 变量 | 所属模块 | 说明 |
|------|---------|------|
| `liveSessions` | `useTerminalManager` | 直播终端表，key 是 PTY 侧 session ID（placeholder） |
| `ptyToDisplay` | `useTerminalManager` | `new_xxx` → 真实 UUID 的迁移映射 |
| `liveDisplayIds` | `useTerminalManager` | reactive Set，驱动关闭按钮显隐 |
| `pollTimer` | `useTerminalManager` | PTY 输出轮询定时器（100ms 间隔） |
| `checking` | `useSessionMonitor` | Set 互斥锁，防止 async 轮询竞态 |
| `settings` | `useSettings` | 模块级 reactive 单例，字号/字体/通知开关 |
| `isFocused` | `useWindowFocus` | 模块级 ref，窗口焦点状态 |
| `props.sessionId` | TerminalPanel | 当前显示哪个会话（唯一真相源） |

**切换流程**：
```
watch(sessionId) → showSession(sid) + loadPreviewContent(sid)
  ├─ liveSessions 有 PTY → 显示对应 div，fit()
  └─ 没有 PTY → 显示 HTML 预览 div + 加载消息历史
```

## 会话 ID 迁移

`startClaude()` 用 placeholder `new_<timestamp>` 创建 PTY → 3 秒后 `scheduleMigration()` 开始扫描（最多重试 3 次，间隔 3 秒）→ 调 `listSessions()` 找到真实 UUID → 更新 `ptyToDisplay` 映射 → `onSessionUpdated` 刷新侧栏。

重试用 `knownIds` Set 记录已知会话，只匹配新出现的会话，避免匹配到遗留旧会话。

**迁移后侧栏刷新**：`onSessionUpdated(realId)` 先 `activeSessionId = realId`，再 `await nextTick()`，然后 `migrateSession(oldId, newId)` 用 `splice` 原地替换占位符条目。**不能直接调 `loadSessions()`**——Vue props 传播是异步的，`loadSessions()` 读 `props.activeSessionId` 时拿的仍是旧值，导致占位符被重新添加。

**为什么不能 `pty_rename_session`**：`startClaude()` 的 `terminal.onData` 和 `ResizeObserver` 闭包捕获了 placeholder ID，所有 `ptyWrite`/`ptyResize` 都用 `new_xxx` 发到 Rust。若把 HashMap key 改成真实 UUID，闭包发的旧 key 就找不到 PTY，输入和 resize 全部静默失败。

## 会话系统 — 适配 Claude Code 存储

```
~/.claude/
├── sessions/<pid>.json          {pid, sessionId, cwd, name, startedAt, kind}
└── projects/<encoded-cwd>/
    └── <sessionId>.jsonl        每行 JSON event (type: user/assistant/system/...)
```

路径编码: `C:\path\to\project` → `C--path-to-project`（`:` 和 `\` → `-`）

Aide 自己的元数据: `~/.claude-code-desktop/sessions/<sessionId>.json` — 只存 displayName。

## 工作区系统

`WorkspaceState` 存两个字段：
- `key`：encoded 目录名（如 `C--document-owner-cypress-agent`），定位 `~/.claude/projects/<key>/` 下的会话
- `path`：真实文件系统路径，用于文件树、PTY cwd 等文件操作

路径解析（`resolve_path_from_key`）：DFS 搜索文件系统，对每个 `-` 尝试分隔符或字面量，找到磁盘上存在的路径，解决编码有损问题。

持久化：`set_workspace` 时 key 写到 `~/.claude-code-desktop/config.json`，启动时读回。

## 设置系统

`~/.claude-code-desktop/config.json`：
```json
{ "workspace": "C-Users-...", "settings": { "font_size": 14, "keybindings": { "searchOpen": "Ctrl+P" }, ... } }
```

`AppSettings` 含 `font_size`, `font_family`, `notifications_enabled`, `proxy`, `shell_path`, `workbench_height`, `keybindings { search_open }`。

前端 `useSettings` 模块级 reactive 单例；`useTerminalManager` watch `settings.fontSize`/`fontFamily` 即时应用到所有终端。

## 自定义（扩展）系统

| 类型 | 存储 |
|------|------|
| 智能体 | `~/.claude/agents/<name>.md` |
| 技能 | `~/.claude/skills/<name>/SKILL.md` |
| 指令 | `~/.claude/CLAUDE.md` + 项目 `CLAUDE.md`（单例） |
| 钩子 | `~/.claude/settings.json` → `hooks` |
| MCP 服务器 | `~/.claude/settings.json` → `mcpServers` |

已知缺口：toggle 全是 no-op，创建只有 `prompt()` 填名字，类型专属字段未实现。

## 插件市场

市场源：`anthropics/claude-plugins-community`（GitHub），清单路径 `.claude-plugin/marketplace.json`。Rust 侧 `git clone --depth 1` 拉取，支持三种 `source` 格式：外部仓库 URL、仓库子目录、内置相对路径。

代理检测：TCP 端口扫描 (7890/10809) → 环境变量 → git config → 应用设置 `proxy` 字段。

错误处理：Rust 返回 `CODE: details`（NETWORK_FAILURE/REPO_NOT_FOUND/TIMEOUT/UNKNOWN_ERROR）。前端 `parseGitError()` 映射为用户消息 + 操作按钮，错误文案集中在 `src/utils/errors.ts` 的 `ERROR_MAP`。

## 桌面通知

**不依赖 `tauri-plugin-notification`**——dev 模式下该插件故意跳过 `app_id`。直接用 `notify-rust`：

```rust
n.app_id("com.aide.app");  // 强制设，不论 dev/prod
n.auto_icon();
n.summary(&title).body(&body).show();
```

触发链：`checkSessionState()` 检测 `esc to interrupt` 消失 → `setSessionState("waiting")` → `useNotification` watch 触发 → 检查 `loaded && notificationsEnabled && !isFocused` → `api.notifySend()`。

## 标题栏搜索

`SearchBox.vue`：`Ctrl+P` 聚焦，搜索源通过 `SearchProvider` 接口插件化注册（`useSearchProviders`）。内置 `SessionProvider`（模糊匹配会话名）和 `FileProvider`（递归遍历目录树，缓存 30s）。结果面板 Teleport to body，↑↓/Enter/Esc 键盘导航。选中文件 → `useFileViewer().open()`。

## Tauri Commands 速查

### PTY
| 命令 | 参数 | 说明 |
|------|------|------|
| `pty_spawn_claude` | `rows, cols, session_id` | 启动 `claude --resume <id>` |
| `pty_write` | `session_id, data` | 键盘输入 → PTY stdin |
| `pty_resize` | `session_id, rows, cols` | 同步 PTY 行列 |
| `pty_kill` | `session_id` | 关闭 Claude 进程 |
| `pty_has_session` | `session_id` | 检查是否有活 PTY |
| `poll_pty_output` | `session_id` | 拉取并清空输出缓冲区（100ms 轮询） |

### 文件系统
| 命令 | 说明 |
|------|------|
| `get_project_info` | `{root, name, branch}`，检测 `.git`/`package.json`/`Cargo.toml` |
| `list_directory` | 过滤 `.`开头、`node_modules`、`target`、`dist` |
| `file_open` | 系统默认程序打开（Windows: `cmd /c start`） |
| `read_file_content` / `write_file_content` | 读写文件内容 |
| `delete_file` / `create_file` / `create_dir` | 文件系统操作 |

### Git
| 命令 | 说明 |
|------|------|
| `git_diff_files` | `git diff --numstat` + 未追踪文件，用于变更日志 |
| `git_stage_all` | `git add -A`，轮次开始前快照 |
| `git_revert_file` | `git checkout -- <path>`，撤回单文件 |
| `git_log` | 提交历史（hash/subject/author/date） |
| `git_show` | 提交详情 + 文件列表 |
| `git_branches` / `git_checkout` | 分支列表 / 切换 |
| `git_diff_content` | 原始 diff 文本（支持 staged/commit） |
| `git_status` | `--porcelain` 解析 |
| `git_commit` | 提交，先检查工作区非空 |

### 会话
| 命令 | 说明 |
|------|------|
| `list_sessions` | 扫描 `.jsonl` + pid JSON + Aide 元数据 |
| `load_messages` | 解析 `.jsonl` 提取 user/assistant 文本 |
| `create_session` | placeholder `new_<timestamp>` |
| `delete_session` / `rename_session` | 删除 / 重命名 |
| `list_workspaces` | 扫描 `~/.claude/projects/`，DFS 解析真实路径 |
| `set_workspace` | 存 key + path 到 config.json |
| `get_settings` / `set_settings` | 读写设置（合并，不覆盖 workspace） |
| `notify_send` | 直接发系统通知 |

### 自定义（25 命令）
`list/get/create/update/delete/toggle_agent`（skill/hook/mcp_server 同 pattern）。指令用 `get/save_global_instructions` + `get/save_project_instructions`。

### 市场（4 命令）
`fetch_marketplace` / `install_plugin` / `uninstall_plugin` / `list_installed_plugins`
