# Agent SDK 迁移设计

> 将 Aide 从 PTY 包裹 Claude CLI 改为通过 Claude Agent SDK 驱动对话，彻底解决会话结束检测不准确的问题。

## 背景与动机

当前 Aide 通过 `portable-pty` 启动 `claude` CLI 子进程，依赖终端尾部文本轮询（"esc to interrupt"）判断对话状态。该方案脆弱、bug 反复，根本原因是：**文本解析无法精确感知结构化的对话边界**。

目标：用 Claude Agent SDK 的 `query()` 事件流替代 PTY，获得精确的 `stop_reason`、工具调用边界、权限钩子。

## 决策摘要

| 问题 | 决策 |
|------|------|
| 替换范围 | 完全替换 PTY/CLI，全套工具由 SDK 提供 |
| UI 形态 | Chat UI（气泡流）+ bash 输出内嵌 xterm 块 |
| SDK 位置 | Node.js sidecar（TypeScript Agent SDK 需要 Node.js 环境） |
| 会话持久化 | Aide 自己写 JSONL，格式兼容 Claude CLI |
| 权限模型 | 安全工具自动批准，危险操作弹 UI 确认框 |
| 多厂商扩展 | Sidecar 是 Claude 专属；其他厂商可用 Rust HTTP 或独立 sidecar，前端/Rust 层不变 |

## 整体架构

```
前端 Vue (WebView)
  ChatPanel.vue
  useChatSession.ts       ← 监听 Tauri events，维护 messages[]
  PermissionDialog.vue    ← 危险操作确认
        ↕ Tauri events / invoke
Rust (Tauri backend)
  sidecar.rs              ← 启动/停止/通信 Node.js sidecar
  conversation.rs         ← JSONL 持久化（格式兼容 Claude CLI）
  commands/chat.rs        ← send_message / permission_response
        ↕ stdin/stdout JSON lines
Node.js sidecar (agent-sidecar/)
  index.ts                ← @anthropic-ai/claude-agent-sdk query()
                             流式输入模式（AsyncGenerator）
                             canUseTool 回调 → 权限确认
                             所有事件序列化为 JSON line → stdout
```

### 多厂商扩展点

```
Claude:   Node.js sidecar → Agent SDK
OpenAI:   Rust HTTP → OpenAI API        （未来）
Gemini:   Rust HTTP → Gemini API        （未来）
          ↓ 统一 ChatEvent 格式
          前端 ChatPanel（不感知厂商）
```

## 核心数据类型（IPC 协议）

Sidecar stdout 输出 JSON lines，每行一个 `ChatEvent`：

```typescript
type ChatEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "permission_request"; id: string; name: string; input: unknown }
  | { type: "message_stop"; stop_reason: string }
  | { type: "session_init"; session_id: string }
  | { type: "error"; message: string }
```

Sidecar stdin 接收控制指令：

```typescript
type SidecarCommand =
  | { cmd: "send"; prompt: string; session_id?: string }
  | { cmd: "permission_response"; id: string; approved: boolean }
  | { cmd: "interrupt" }
```

## Sidecar 实现（agent-sidecar/）

Sidecar 使用**流式输入模式**（`prompt: AsyncGenerator`），支持多轮对话、实时中断和权限确认。

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// 消息队列：stdin 指令注入新消息
const messageQueue: SDKUserMessage[] = [];
let resolveNext: (() => void) | null = null;

async function* messageGenerator(): AsyncGenerator<SDKUserMessage> {
  while (true) {
    if (messageQueue.length > 0) {
      yield messageQueue.shift()!;
    } else {
      await new Promise<void>(resolve => { resolveNext = resolve; });
    }
  }
}

// canUseTool：危险工具暂停等待前端确认（permissionMode: "default"）
const pendingPermissions = new Map<string, (approved: boolean) => void>();

const canUseTool = async (toolName: string, input: unknown) => {
  const id = crypto.randomUUID();
  emit({ type: "permission_request", id, name: toolName, input });
  const approved = await new Promise<boolean>(resolve => {
    pendingPermissions.set(id, resolve);
  });
  return approved
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "用户拒绝" };
};

for await (const msg of query({
  prompt: messageGenerator(),
  options: {
    permissionMode: "default",   // 未列入 allowedTools 的工具触发 canUseTool
    allowedTools: ["Read", "Glob", "Grep", "Skill"],  // 安全工具自动批准；Skill 允许调用 skills
    canUseTool,
    settingSources: ["project", "user"],
  }
})) {
  // 将 SDK 消息映射为 ChatEvent，写入 stdout
  mapAndEmit(msg);
}
```

**stdin 指令处理：**
```typescript
// "send" → 注入新用户消息到 generator
// "permission_response" → 解除 canUseTool 阻塞
// "interrupt" → AbortController.abort()
```

## Rust 层

**新增文件：**
- `src-tauri/src/sidecar.rs`：管理 sidecar 进程生命周期（启动/读取 stdout/写入 stdin/停止），每个会话对应一个 sidecar 实例
- `src-tauri/src/conversation.rs`：追加 JSONL 记录（兼容 `~/.claude/projects/…/*.jsonl` 格式）
- `src-tauri/src/commands/chat.rs`：暴露 `send_message`、`permission_response`、`interrupt_session` 命令

**移除文件：**
- `src-tauri/src/pty.rs`
- `src-tauri/src/commands/pty.rs`

**保留复用：**
- `src-tauri/src/commands/session.rs`（读取 JSONL、列举会话）
- `src-tauri/src/commands/filesystem.rs`、`git.rs` 等工具实现（sidecar 通过 SDK 内置工具执行，Rust 侧工具实现暂时保留供其他厂商路径复用）

## 前端层

**新增：**
- `src/components/ChatPanel.vue`：主容器，替换 TerminalPanel
- `src/components/ChatMessage.vue`：单条消息渲染（用户/助手/工具）
- `src/components/ToolCallBlock.vue`：工具调用卡片（可折叠）
- `src/components/BashOutputBlock.vue`：bash 输出（内嵌 xterm）
- `src/components/PermissionDialog.vue`：危险操作确认弹窗
- `src/composables/useChatSession.ts`：替换 useTerminalManager，监听 Tauri events

**移除：**
- `src/components/TerminalPanel.vue`
- `src/composables/useTerminalManager.ts`
- `src/composables/useSessionMonitor.ts`（状态由 `message_stop` 精确感知，不再需要）

## 权限模型

| 工具 | 处理方式 |
|------|---------|
| Read, Glob, Grep, LS | 自动批准 |
| Bash, Write, Edit, WebFetch | `canUseTool` 回调暂停 → PermissionDialog → 用户确认/拒绝 |

## 会话持久化

- Sidecar 的 `session_init` 事件携带 `session_id`
- Rust 在 `~/.aide/sessions/<session_id>.jsonl` 写入对话记录
- 格式与 Claude CLI JSONL 兼容，`session.rs` 现有读取逻辑可直接复用
- 续接会话：`send` 指令携带 `session_id`，Agent SDK `resume` 选项恢复上下文

## Tauri Sidecar 打包

- `agent-sidecar/` 目录为独立 Node.js 项目，用 `esbuild` 打包为单文件
- 在 `tauri.conf.json` 的 `bundle.externalBin` 注册，随 app 分发
- Rust 通过 `tauri-plugin-shell` sidecar API 启动，无需用户本地安装 Node.js

## Skills 与 Plugins 支持

**无需重新实现**——SDK 通过 `settingSources` 原生支持。

| 功能 | 加载路径 | 触发条件 |
|------|---------|---------|
| 用户 skills | `~/.claude/skills/*/SKILL.md` | `settingSources` 含 `"user"` |
| 项目 skills | `.claude/skills/*/SKILL.md` | `settingSources` 含 `"project"` |
| 插件（marketplace 安装） | `~/.claude/plugins/…` | `settingSources` 含 `"user"` |
| 项目 hooks | `.claude/settings.json` | `settingSources` 含 `"project"` |

**Aide 现有 marketplace（`marketplace.rs` / `useMarketplace.ts`）完全保留**：插件安装到 filesystem，SDK 自动识别，无需任何改动。

Sidecar 配置中需确保：
- `settingSources: ["project", "user"]` —— 已包含
- `allowedTools` 含 `"Skill"` —— 允许 Claude 主动调用 skill
- `skills: "all"` —— 启用所有已发现的 skill（或按需配置）

## 迁移策略

1. 搭建 `agent-sidecar/` 项目，验证 SDK 基本 query 流程
2. 实现 Rust `sidecar.rs` + `commands/chat.rs`，打通 IPC
3. 新建 `ChatPanel.vue` 及相关组件，接入 Tauri events
4. 在 `App.vue` 中用 ChatPanel 替换 TerminalPanel
5. 移除 `pty.rs`、`useTerminalManager.ts`、`useSessionMonitor.ts`
6. 端到端测试：新建会话、续接会话、工具权限确认、对话结束检测
