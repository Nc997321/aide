# Aide — 架构详解

## 交互模型：Chat UI + Agent SDK runtime

中心面板为消息流（`ChatPanel.vue`，assistant 通页书脊布局、user 铜底气泡），对话由 Agent Runtime 里的 Claude Agent SDK `query()` 驱动，不再是 xterm 套壳终端。工具调用渲染为墨线行组（`ToolCallGroup`/`ToolCallBlock`），连续工具调用默认收起摘要，Bash 输出内嵌只读 xterm 块，权限审批走 `PermissionDialog` 弹窗。工作台 shell 终端（`WorkbenchTerminal` + `shell.rs` PTY）与对话无关，仍保留。

## 三层结构

```
前端 Vue (WebView)
  ChatPanel.vue / ChatMessage.vue / PermissionDialog.vue
  useChatSession.ts        ← 全局 chat-event 监听 + 每会话独立 store
        ↕ Tauri events / invoke
Rust (Tauri backend)
  runtime.rs               ← 单一持久 aide-agent.exe：spawn_runtime / send / kill_runtime + 连接指纹
  commands/chat.rs         ← send_message / permission_response / interrupt / stop
        ↕ stdin/stdout JSON lines（SidecarCommand / ChatEvent）
Agent Runtime (agent-sidecar/)
  index.ts                 ← 进程入口；SessionManager 按 session_id 多路复用 SessionWorker
  session-worker.ts        ← 每个 worker 跑 @anthropic-ai/claude-agent-sdk query()，流式输入
                              canUseTool 回调 → 权限确认（signal abort → 取消）
```

**Provider 抽象**：前端与 Rust 只认 `ChatEvent`/`SidecarCommand` 协议；Anthropic 专属逻辑（消息格式、SDK 调用）只存在于 `agent-sidecar/`。接入新厂商 = 新增一个输出同协议的 runtime。

## 数据流

```
用户发送 → useChatSession.sendMessage
  → invoke("send_message")（确保 Runtime 已启动，注入 provider/代理环境变量）
    → Runtime stdin {"cmd":"send", prompt, images?, session_id?}
      → SDK query() 事件流 → mapper.ts 映射为 ChatEvent
        → stdout JSON line → runtime.rs reader 任务
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
| `waiting` | message_stop（Runtime 存活空闲）/ interrupt |
| `stopped` | error / 进程意外退出 / stop_chat_session |

通知、任务栏进度、回焦横幅、变更轮次捕获都由 `running/attention → waiting` 转换驱动（`useNotification`、`useConversationChanges`）。

## Agent Runtime 管理（Rust 侧）

`AgentRuntimeManager`（`runtime.rs`）启动并持有**单一持久 `aide-agent.exe` 进程**（dev 模式跑 `node runtime.js`，release 直接跑编译好的 `aide-agent.exe`），Rust 不再「每会话一个进程」——只持有该 Runtime 的 stdin / Child 句柄 + 连接身份指纹注册表。SessionWorker 的多路复用发生在 Runtime 进程内部（JS 侧）按 `session_id` 路由：

- **stdout reader 任务**：逐行解析 JSON → 携带事件自带的 `session_id` → `emit("chat-event")`。Runtime 进程退出且非主动 kill → 发一条 `error` 事件（附 stderr 尾部）解除前端 isBusy。
- **stderr reader 任务**：只 `eprintln!` + 存 8 行尾部环形缓冲。**stderr 不是错误**——Node/Bun warning 不会打断会话。
- **连接身份指纹**：每个 session 首次 spawn 时记下 base_url/api_key/auth_token/代理子集，跨 Runtime 重启持久（`kill_runtime` 不删它）；后续 send 时跟当前 provider 配置比对，判断要不要 `forkSession` 绕开 CLI session 文件里缓存的旧 provider 配置。

## 会话 ID 生命周期（延迟创建）

不预先分配任何身份，"创建会话"这件事推迟到第一次真正发消息、拿到 SDK 返回的真实 session id 之后再做——没有草稿阶段，就没有"事后改名"这一步：

1. 点"新建会话"：前端只清空 `activeSessionId`，打开空白可输入面板。**不调用任何 Tauri 命令，不落盘，不进侧栏。**
2. 用户发送第一条消息：若当前无 session id，`useChatSession.ts` 现场生成一个纯内存临时 key（`crypto.randomUUID()`，记入 `pendingSids`），建本地 store 并调 `send_message`——这一步同样不落盘，只是 Rust `AgentRuntimeManager` 指纹注册表和前端 `stores`/`sessionState` 的运行时 key。
3. Runtime 首个 `session_init` 事件携带 `sdk_session_id` → 前端 `finalizeSession`：原地搬迁 `stores`/`sessionState`（写 `aliasMap` 兜住 Runtime 内 re-key 完成前仍带旧 key 的在途事件）→ 从 `pendingSids` 移除 → 触发 `onSessionCreated` 回调。**re-key 在 Runtime 进程内部 SessionManager 内存里原子完成**（worker 的 Map key 从 tempId 迁到 SDK realId），前端不再 invoke 任何 rename 命令（旧 `rename_sidecar_session` 已删除）。
4. App.vue 的 `onSessionCreated(tempId, realId)`：**这时才第一次落盘**——`create_session(realId, name)` 写 `~/.aide/sessions/<id>.json` 名字元数据、`sidebarRef.addSession(...)` 加侧栏、`recordCurrentSession` 记最近访问。

此后 aide ID 永远等于 SDK session ID，不再改名。**续接**：`sendMessage` 的 resume 直接用 `sid` 本身（`isPendingSession(sid) ? undefined : sid`，无需任何映射表；重启后点开历史会话同样直接传自身 ID；SDK `forkSession` 默认 false，resume 延续同一 session ID）。若发消息后从未等到 `session_init`（进程崩溃、网络失败等），全程没有写盘、没有侧栏条目、没有最近访问记录——失败的尝试不留痕迹。

## 会话系统 — 适配 Claude Code 存储

Aide 把 `CLAUDE_CONFIG_DIR` 显式注入 sidecar 指向 `~/.aide/claude/`（见 `runtime/mod.rs` 的 `spawn_runtime`），使内置 claude.exe 把所有自有数据写到 Aide 自管理目录下的 `claude/` 子目录，而非回退到用户系统的 `~/.claude/`——Aide 不依赖系统是否装了 Claude CLI。`claude_home()`（`commands/mod.rs`）即返回此目录，所有 Claude 路径（settings/CLAUDE.md/agents/skills/projects/sessions/plugins）从它派生。

```
~/.aide/claude/                       ← claude_home() / CLAUDE_CONFIG_DIR
├── sessions/<pid>.json              {pid, sessionId, cwd, name, startedAt, kind}  (claude.exe 写)
└── projects/<encoded-cwd>/
    └── <sessionId>.jsonl             每行 JSON event (type: user/assistant/system/...)  (claude.exe 写)
```

路径编码: `C:\path\to\project` → `C--path-to-project`（`:` 和 `\` → `-`）

Aide 自己的元数据: `~/.aide/sessions/<sessionId>.json` — 只存 displayName（与上面 claude.exe 的 `claude/sessions/` 分目录、schema 不同，按所有权分离）。

### 一次性迁移

升级到 `~/.aide/` 的现有用户有两类数据要搬（`commands/migration.rs`）：
- **Aide 数据目录改名**（启动时自动，`ensure_aide_data_dir_migrated`）：老根 `~/.claude-code-desktop/` 原子 rename 到 `~/.aide/`，在 `run()` 最开头、`init_logging` 之前执行。
- **Claude CLI 数据迁移**（用户弹窗触发，`migrate_claude_data`）：把用户系统 `~/.claude/` 拷到 `~/.aide/claude/`，拷贝不移动、只补缺失项不覆盖已有（幂等 + 解决「迁移前先开了会话」的边界）。状态记在 `~/.aide/config.json` 顶层 `claudeMigrationDone`/`claudeMigrationDismissed`。

## 工作区系统

**显式注册表（2026-09-07 起）**：工作区列表的唯一事实源是 state.json 的 `registeredWorkspaces` 数组（`commands/workspace/registry.rs`），`list_workspaces` 只读它——不再扫 `~/.aide/claude/projects/` 推导。内部流程（automation 等）以 cwd 身份往 Claude 目录写转录，不再可能混进侧栏；`try_decode` 反向解码猜错的「路径不存在」假警告随之消失。设计决策与事故背景见 `docs/superpowers/plans/2026-09-07-workspace-explicit-registry.md`。

登记触发点（全部幂等，按 key 去重）：打开目录（`create_workspace`）、`send_message` 前的会话 cwd ensure（首聊回落 home 的隐式工作区照常出现；automation 走 scopes 隔离不经此路径）、启动一次性迁移（`ensure_registry_migrated`，扫历史转录目录播种，marker 幂等）、`unhide_workspace` 重登记。条目 `{ key, path, addedAt }`：path 是身份主人，key 由 `path_to_key(path)` 注册时算出后冻结（sessions/recent/lsp/codegraph/jdk 各段共用该身份）；`missing` = 注册路径磁盘不存在（准确信号）。

`WorkspaceState` 存两个字段（内存激活态，与注册表正交）：
- `key`：encoded 目录名（如 `C--document-owner-cypress-agent`），定位 `~/.aide/claude/projects/<key>/` 下的会话
- `path`：真实文件系统路径，用于文件树、PTY cwd 等文件操作

路径解析（`resolve_path_from_key`）：DFS 搜索文件系统，对每个 `-` 尝试分隔符或字面量，找到磁盘上存在的路径，解决编码有损问题。注册表落地后它的运行时用途只剩两个：启动迁移解码历史目录 key、活动工作区恢复的回退（恢复优先查注册表）。

持久化：激活 key 写 state.json 的 `workspace` 字段，启动时读回。`hiddenWorkspaces` 黑名单不再是列表过滤源——`remove_workspace` hide 仍写它（降级回旧版重扫目录时不复活），迁移跳过它，`list_workspaces` 不读它。转录隔离双防线：automation 等内部流程写 `~/.aide/scopes/<kind>/<id>/claude`（不进被任何列表消费的全局目录）+ 登记制本身。

## 设置系统

Aide 用**分层 settings document + OS 凭据库**取代旧的单一 `~/.aide/config.json`：

- **分层文件**（高 → 低，低层可覆盖高层非敏感字段）：受管策略（Windows `%ProgramData%/Aide/settings.json` / macOS `/Library/Application Support/Aide/settings.json` / Linux `/etc/aide/settings.json`，只读）→ 用户全局 `~/.aide/settings.json` → 项目共享 `<project>/.aide/settings.json` → 项目本地 `<project>/.aide/settings.local.json` → 会话临时层（仅内存）。所有文档共享 `SettingsDocument { schemaVersion, values, permissions }` 外层，未知 `values` 字段 round-trip 保留。
- **秘密隔离**：API key / auth token / CodeGraph key 只存 OS 凭据库（`keyring` crate，服务名 `io.aide.desktop`），绝不落 `settings*.json`；公开 DTO 只暴露 `*Configured: boolean`，runtime-only 的已解析 `ProviderConfig`（含明文）只在 Rust 内存。详见 `settings/secrets.rs`。
- **权限策略**：`allow | ask | deny` 规则按 scope 分层存储，sidecar 在 `PreToolUse` hook 最前置评估。上层 `deny` 不可被下层 `allow` 放宽，无匹配回退 provider permission mode（`defer`）。详见 `policy/`。
- **配置文件迁移**：首次启动把旧 `~/.aide/config.json` 一次性迁移为 `~/.aide/settings.json`，秘密抽进 keychain，脱敏备份 `config.json.migrated.bak`；迁移幂等（新 document 已存在后不再读旧文件）。

`SettingsService`（`settings/mod.rs`）是统一入口：`initialize_blocking` → `effective_document_blocking` → `mutate_scope_blocking`（原子写 + 重算 snapshot + 广播）；Tauri command 仅薄异步 facade（`Arc<SettingsService>` + `spawn_blocking`，禁止同步重 IO）。前端 `useSettings` / `usePermissions` 模块级 reactive 单例；`useTerminalManager` watch `settings.fontSize`/`fontFamily` 即时应用到所有终端。

> 用户文档、文件位置与可写性全表、precedence 规则、7 步手工验收矩阵见 [docs/testing/permission-settings-manual-acceptance.md](testing/permission-settings-manual-acceptance.md)。Aide 不读写或解释 Claude Code 的 `.claude/settings.json` 权限规则。

## 自定义（扩展）系统

| 类型 | 存储 |
|------|------|
| 智能体 | `~/.aide/claude/agents/<name>.md` |
| 技能 | `~/.aide/claude/skills/<name>/SKILL.md` |
| 指令 | `~/.aide/claude/CLAUDE.md` + 项目 `CLAUDE.md`（单例） |
| 钩子 | `~/.aide/claude/settings.json` → `hooks` |
| MCP 服务器 | `~/.aide/claude/settings.json` → `mcpServers` |

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

触发链：Runtime `message_stop` 事件 → `useChatSession` `setSessionState("waiting")` → `useNotification` watch 触发 → 检查 `loaded && notificationsEnabled && !isFocused` → `api.notifySend()`。

## 标题栏搜索

`SearchBox.vue`：`Ctrl+P` 聚焦，搜索源通过 `SearchProvider` 接口插件化注册（`useSearchProviders`）。内置 `SessionProvider`（模糊匹配会话名）和 `FileProvider`（按查询实时调服务端 `find_files_by_name`，`ignore` crate 尊重 .gitignore，无客户端缓存）。结果面板 Teleport to body，↑↓/Enter/Esc 键盘导航。选中文件 → `useFileViewer().open()`。

## Tauri Commands 速查

### Chat（Agent SDK）
| 命令 | 参数 | 说明 |
|------|------|------|
| `send_message` | `session_id, prompt, images?, resume_id?` | 确保 Runtime 已启动，转发 send 指令 |
| `permission_response` | `session_id, id, approved` | 解除 canUseTool 阻塞 |
| `interrupt_session` | `session_id` | SDK query.interrupt() |
| `stop_chat_session` | `session_id` | 发 session_stop 给 Runtime，停掉该会话 worker（不杀进程） |

（工作台终端另有 `pty_*` 命令走 `shell.rs`，与对话无关。）

### 文件系统
| 命令 | 说明 |
|------|------|
| `get_project_info` | `{root, name, branch}`，检测 `.git`/`package.json`/`Cargo.toml` |
| `list_directory` | 两个独立开关：`show_hidden`（`.`开头）与 `include_ignored`（`node_modules`/`target`/`dist`），默认全关 |
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
| `git_diff_pair` | 新旧双份原文 diff 数据，支持 staged/commit，含行尾归一化与 1MB 上限 |
| `git_status` | `--porcelain` 解析 |
| `git_commit` | 提交，先检查工作区非空 |

### 会话
| 命令 | 说明 |
|------|------|
| `list_sessions` | 扫描 `.jsonl` + pid JSON + Aide 元数据 |
| `load_messages` | 解析 `.jsonl` 提取 user/assistant 文本 |
| `create_session` | `id, name` — 调用方传入真实 id（首次 `session_init` 之后才调用，见「会话 ID 生命周期」） |
| `delete_session` / `rename_session` | 删除 / 重命名 |
| `list_workspaces` | 读 `registeredWorkspaces` 注册表（显式登记，见「工作区系统」） |
| `set_workspace` | 存 key + path 到 state.json |
| `get_settings` / `set_settings` | 读写设置（合并，不覆盖 workspace） |
| `notify_send` | 直接发系统通知 |

**已知技术债**：`list_sessions`/`load_messages`/`session_last_event` 直接解析 `~/.claude/projects/*.jsonl`——这是 Claude Code CLI 专属的 transcript 格式（`isMeta`/`interruptedMessageId`/`isCompactSummary`/`origin.kind` 等字段），绕开了 Runtime 的 `ChatEvent` 协议，是 Rust 层里唯一对 Claude 专属格式有直接认知的地方。接入非 Claude provider 时，历史加载这条路径需要重新设计（例如把"读历史"也交给各 provider 的 runtime，经统一协议吐给 Rust），不能照搬现在直接读文件的做法。

`get_default_models` 是同一类例外，但边界更干净：它只读 `agent-sidecar/default-models.json` 这一份纯数据文件（会话开始前没有活的 SDK 连接时，聊天面板顶部模型下拉的静态兜底列表），原样透传 `serde_json::Value`，不解析、不引用任何 Claude 专属字段名——数据内容是 Claude 的模型别名，但这份数据物理上归 `agent-sidecar` 所有，Rust 代码本身不出现任何 provider 专属知识。接入新 provider 时，这个文件和读取方式需要对应换成该 provider 自己的默认模型数据。

### 自定义（25 命令）
`list/get/create/update/delete/toggle_agent`（skill/hook/mcp_server 同 pattern）。指令用 `get/save_global_instructions` + `get/save_project_instructions`。

### 市场（4 命令）
`fetch_marketplace` / `install_plugin` / `uninstall_plugin` / `list_installed_plugins`
