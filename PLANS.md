# 产品待办清单

> 优先级从高到低排列

## P0 — 核心体验

### 1. 流式输出 ✅（PTY 架构原生支持）

### 2. 代码块语法高亮 ✅（FileViewer + 预览 markdown 渲染）

## P1 — 功能完善

### 3. 停止按钮 ✅（终端右上角 ⏹）

### 4. 新建文件/文件夹 ✅（右键菜单已接入 create_file/create_dir）

### 5. 工作区切换 ✅（侧栏工作区列表 + 切换，FileTree 路径栏下拉）

## P2 — 打磨

### 6. 会话搜索 ✅（已实现）

### 7. 窗口状态记忆 ✅（已实现 — `tauri-plugin-window-state`）

### 8. 自定义功能区读真实配置

**现状**：智能体/技能/指令/钩构/MCP 是写死的 5 行标签。

**方案**：新增 `list_claude_config` 命令，读取 `~/.claude/agents/`、`~/.claude/skills/`、`~/.claude/settings.json` 等，返回各功能区统计数据。前端接入真实数字。

**涉及文件**：`commands.rs`、`SidebarLeft.vue`

---

## 建议起步顺序

**流式输出** → **语法高亮** → **停止按钮** → **新建文件/文件夹** → **工作区切换** → 其余

理由：流式输出让聊天"活"起来，是感受最强烈的改进。语法高亮投入小收益大。这两个做完后，聊天体验就从原型变成能用。

> ✅ P0~P2 全部 8 项已在 PTY 重构中实现。新增：**文件树"更改"tab**（git diff 文件列表）。

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
