# Aide — 架构详解

## 交互模型：Chat UI + Agent SDK sidecar

中心面板为聊天气泡流（`ChatPanel.vue`），对话由 Node.js sidecar 里的 Claude Agent SDK `query()` 驱动，不再是 xterm 套壳终端。工具调用渲染为可折叠卡片（`ToolCallBlock`），Bash 输出内嵌只读 xterm 块，权限审批走 `PermissionDialog` 弹窗。工作台 shell 终端（`WorkbenchTerminal` + `shell.rs` PTY）与对话无关，仍保留。

## 三层结构

```
前端 Vue (WebView)
  ChatPanel.vue / ChatMessage.vue / PermissionDialog.vue
  useChatSession.ts        ← 全局 chat-event 监听 + 每会话独立 store
        ↕ Tauri events / invoke
Rust (Tauri backend)
  sidecar.rs               ← 每会话一个 sidecar 进程：spawn/send/kill/rename
  commands/chat.rs         ← send_message / permission_response / interrupt / stop
        ↕ stdin/stdout JSON lines（SidecarCommand / ChatEvent）
Node.js sidecar (agent-sidecar/)
  index.ts                 ← @anthropic-ai/claude-agent-sdk query()，流式输入模式
                              canUseTool 回调 → 权限确认（signal abort → 取消）
```

**Provider 抽象**：前端与 Rust 只认 `ChatEvent`/`SidecarCommand` 协议；Anthropic 专属逻辑（消息格式、SDK 调用）只存在于 `agent-sidecar/`。接入新厂商 = 新增一个输出同协议的 sidecar。

## 数据流

```
用户发送 → useChatSession.sendMessage
  → invoke("send_message")（首次自动 spawn sidecar，注入 provider/代理环境变量）
    → sidecar stdin {"cmd":"send", prompt, images?, session_id?}
      → SDK query() 事件流 → mapper.ts 映射为 ChatEvent
        → stdout JSON line → sidecar.rs reader 任务
          → 补 session_id 字段 → app.emit("chat-event")
            → useChatSession 全局监听 → 按 session_id 路由到对应 store
```

**事件即推送**：ChatEvent 是低频结构化事件（文本块/工具边界/权限/结束），不存在旧 PTY 时代淹没事件循环的问题，无需轮询。

**每会话独立 store**：`stores[sessionId] = { messages, isBusy, pendingPermission, hydrated }`（模块级 reactive）。前台/后台会话走同一条写入路径，切换会话零拷贝；历史懒加载（`hydrate` 读 `.jsonl` 一次）。

## 会话状态指示器

四种状态，通过 `useSessionState`（模块级 `reactive` 单例）跨组件共享，由 ChatEvent **精确驱动**（不再解析终端文本）：

| 状态 | 触发事件 |
|------|---------|
| `running` | sendMessage 发出 / session_init / 权限批准后 |
| `attention` | permission_request（等用户确认） |
| `waiting` | message_stop（sidecar 存活空闲）/ interrupt |
| `stopped` | error / 进程意外退出 / stop_chat_session |

通知、任务栏进度、回焦横幅、变更轮次捕获都由 `running/attention → waiting` 转换驱动（`useNotification`、`useConversationChanges`）。

## Sidecar 管理（Rust 侧）

`SidecarManager` 维护 `HashMap<String, SidecarSession>`，每会话一个 Node 进程：

- **stdout reader 任务**：逐行解析 JSON → 注入 `session_id`（读共享 `Arc<Mutex<String>>`，rename 后立即生效）→ `emit("chat-event")`。流结束且非主动 kill → 发一条 `error` 事件（附 stderr 尾部）解除前端 isBusy。
- **stderr reader 任务**：只 `eprintln!` + 存 8 行尾部环形缓冲。**stderr 不是错误**——Node warning 不会打断会话。
- **rename(old, new)**：会话 ID 迁移时重挂 HashMap key + 更新共享 sid。

## 会话 ID 生命周期

1. 新建会话：`create_session` 生成草稿 ID `new_<timestamp>`（此时还没有 SDK 会话）。
2. 首条消息发出 → sidecar 首个 `session_init` 事件携带 `sdk_session_id`。
3. 前端 `migrateStore`：立即换 store key + 写 `aliasMap`（兜住 Rust rename 完成前仍带旧 ID 的在途事件）→ invoke `migrate_session`。
4. Rust `migrate_session` 一次性迁移四个落点：sidecar 注册表（最先）、`~/.claude-code-desktop/sessions/<id>.json` 名字元数据、`<id>-changes.json` 变更轮次、`recent.json`。
5. `onSessionMigrated` 回调 → 侧栏 `migrateSessionId` 原地 splice 换 ID + `activeSessionId` 同步 + 记入最近访问。**不能 `loadSessions()`**——props 异步传播会把旧条目加回来。

此后 aide ID == SDK session ID。**续接**：`sendMessage` 的 resume 三级兜底——显式传入 > 运行期 `sdkSessionMap` > 自身 ID（重启后点开历史会话靠第三级；SDK `forkSession` 默认 false，resume 延续同一 session ID）。

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

触发链：sidecar `message_stop` 事件 → `useChatSession` `setSessionState("waiting")` → `useNotification` watch 触发 → 检查 `loaded && notificationsEnabled && !isFocused` → `api.notifySend()`。

## 标题栏搜索

`SearchBox.vue`：`Ctrl+P` 聚焦，搜索源通过 `SearchProvider` 接口插件化注册（`useSearchProviders`）。内置 `SessionProvider`（模糊匹配会话名）和 `FileProvider`（递归遍历目录树，缓存 30s）。结果面板 Teleport to body，↑↓/Enter/Esc 键盘导航。选中文件 → `useFileViewer().open()`。

## Tauri Commands 速查

### Chat（Agent SDK）
| 命令 | 参数 | 说明 |
|------|------|------|
| `send_message` | `session_id, prompt, images?, resume_id?` | 首次自动 spawn sidecar，转发 send 指令 |
| `permission_response` | `session_id, id, approved` | 解除 canUseTool 阻塞 |
| `interrupt_session` | `session_id` | SDK query.interrupt() |
| `stop_chat_session` | `session_id` | kill sidecar 进程 |
| `migrate_session` | `old_id, new_id` | 会话 ID 迁移（注册表/元数据/变更/最近访问） |

（工作台终端另有 `pty_*` 命令走 `shell.rs`，与对话无关。）

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
