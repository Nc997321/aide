# 产品待办清单

> 优先级从高到低排列

## P0 — 核心体验

### 1. 流式输出

**现状**：`claude -p` 阻塞等待完整输出才返回，用户看着空白气泡等很久。

**方案**：`Command::new("claude").stdout(Stdio::piped())` 改为逐行/逐块读取，通过新 event `chat-chunk` 逐段推送到前端，前端在当前气泡上累加文本。`chat-done` 时最终刷新。

**涉及文件**：`commands.rs`（run_claude_print 改流式读）、`ChatPanel.vue`（监听 chat-chunk 追加文本）

### 2. 代码块语法高亮

**现状**：Claude 回复里的代码块没有高亮，只是 `<pre><code>` 纯文本。

**方案**：引入 `highlight.js`（~10KB gzip），在 `renderMarkdown` 后对 `<pre><code>` 做高亮标注。

**涉及文件**：`package.json`、`ChatPanel.vue`

## P1 — 功能完善

### 3. 停止按钮

**现状**：`chat_stop` 后端命令已注册，前端没有调用它的地方。

**方案**：ChatPanel 输入框旁加停止按钮（发送中显示），调用 `invoke("chat_stop")`。Rust 侧需要把 `Child` 存起来以便 kill，当前 spawn 后没持有句柄。

**涉及文件**：`commands.rs`（持有 child 句柄）、`ChatPanel.vue`（停止按钮）

### 4. 新建文件/文件夹

**现状**：右键菜单中这两项 disabled。

**方案**：新增 Rust 命令 `create_file(path, name)` / `create_dir(path, name)`，前端用 `window.prompt` 输入名称。实现后取消 disabled。

**涉及文件**：`commands.rs`、`lib.rs`、`TreeNodeItem.vue`、`menus/contextMenus.ts`

### 5. 工作区切换

**现状**：后端 `list_workspaces` 已实现，前端未接入。始终显示当前项目。

**方案**：FileTree 路径栏加下拉箭头，点击列出所有工作区，切换后刷新会话列表+文件树。需要把当前工作区提升为 App.vue 级别的状态。

**涉及文件**：`FileTree.vue`、`SidebarLeft.vue`、`App.vue`

## P2 — 打磨

### 6. 会话搜索

**现状**：会话多了只能滚动找。

**方案**：SidebarLeft 顶部加搜索输入框，本地过滤 `sessions` 数组（模糊匹配 name）。

**涉及文件**：`SidebarLeft.vue`

### 7. 窗口状态记忆

**现状**：每次打开都是默认大小 1400x900，居中。

**方案**：Tauri plugin `tauri-plugin-window-state` 或手动在 `App.vue` onMounted/onUnmounted 中读写 local storage。

**涉及文件**：`tauri.conf.json`、`App.vue`

### 8. 自定义功能区读真实配置

**现状**：智能体/技能/指令/钩构/MCP 是写死的 5 行标签。

**方案**：新增 `list_claude_config` 命令，读取 `~/.claude/agents/`、`~/.claude/skills/`、`~/.claude/settings.json` 等，返回各功能区统计数据。前端接入真实数字。

**涉及文件**：`commands.rs`、`SidebarLeft.vue`

---

## 建议起步顺序

**流式输出** → **语法高亮** → **停止按钮** → **新建文件/文件夹** → **工作区切换** → 其余

理由：流式输出让聊天"活"起来，是感受最强烈的改进。语法高亮投入小收益大。这两个做完后，聊天体验就从原型变成能用。

---

# 会话系统 — 映射 Claude Code 真实存储

> 当前活跃计划 | H1 级

## 核心理念

**不再自己管理 session**，直接读取 Claude Code 自身的存储：

```
~/.claude/
├── sessions/<pid>.json          {pid, sessionId, cwd, name, startedAt, kind}
└── projects/<encoded-cwd>/
    └── <sessionId>.jsonl        每行一个 JSON event (type: user/assistant/system/...)
```

项目路径编码规则：`C:\document\owner\aide` → `C--document-owner-aide`

## 架构变更

```
列表:  ~/.claude/sessions/*.json  +  ~/.claude/projects/<encoded-cwd>/*.jsonl
       ↓ 过滤当前项目的 session
       ↓
SidebarLeft: 显示该项目下所有对话

加载:  ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
       ↓ 解析 JSONL，取 type=user/assistant 的行
       ↓
ChatPanel: 显示聊天气泡

发送:  chat_send(msg, session_id)
       ├─ 新 session → claude -p "msg"           (不带 --continue/--resume)
       └─ 已有 session → claude -p "msg" --resume <sessionId>
       ↓ Claude 自己写入 .jsonl                 (不需要 app 保存)
       ↓
前端:  重新 load_messages 获取最新对话
```

## 数据映射

| Claude Code 字段 | App Session 字段 |
|------------------|-----------------|
| `sessionId` | `id` |
| `name` | `name` |
| `startedAt` | `timestamp` |
| `.jsonl` 最后一条 assistant 的 text | `last_message` |

`.jsonl` 解析规则：
- `{"type":"user", "message":{"role":"user","content":[{"type":"text","text":"..."}]}}` → ChatMessage(role:"user")
- `{"type":"assistant", "message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}` → ChatMessage(role:"claude")
- 其他 type (`permission-mode`, `file-history-snapshot` 等) → 跳过

## 命令变更

| 旧命令 | 新处理 |
|--------|--------|
| `list_sessions` | 读取 `~/.claude/sessions/*.json` + 扫描 `~/.claude/projects/<encoded-cwd>/*.jsonl`，过滤当前项目 |
| `create_session` | **废弃** — 新 session 由 `claude -p` 不带 flag 自动创建 |
| `delete_session` | 删除 `sessions/<pid>.json` + `projects/<encoded-cwd>/<sessionId>.jsonl` |
| `rename_session` | 修改 `sessions/<pid>.json` 中 name 字段 |
| `save_messages` | **废弃** — Claude 自己写入 `.jsonl` |
| `load_messages` | 解析 `projects/<encoded-cwd>/<sessionId>.jsonl`，提取 user/assistant 文本 |
| `chat_send` | `session_id` 为空 → `claude -p "msg"`；不为空 → `claude -p "msg" --resume <sessionId>` |
| 新增 `list_project_sessions` | 扫描 `~/.claude/projects/<encoded-cwd>/` 下所有 `.jsonl`，返回 session 摘要列表 |

## 文件变更清单

| 文件 | 改动 |
|------|------|
| `src-tauri/src/commands.rs` | 重写 session 命令，读取真实 Claude 存储；chat_send 用 `--resume` |
| `src-tauri/src/lib.rs` | 注册变更后的命令 |
| `src/components/SidebarLeft.vue` | Session 接口适配；列表从当前项目工作区加载 |
| `src/components/ChatPanel.vue` | 适配新的消息格式（文本提取） |
| `src/components/App.vue` | 不变（桥接逻辑已正确） |

## 验证

1. 启动 app → 侧栏显示当前项目（aide）下所有真实 Claude 对话
2. 点击某个对话 → ChatPanel 加载完整历史消息
3. 新建对话（Ctrl+N）→ 新空会话 → 发消息 → `claude -p "msg"` 不带 flag → Claude 创建新 session
4. 在已有对话中继续发消息 → `claude -p "msg" --resume <id>` → Claude 记得上下文
5. 关闭重开 → 对话依旧存在（Claude 自己管理持久化）
