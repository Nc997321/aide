# 子代理（Subagent）支持 — 设计

之前的迁移排查发现：迁移到 Claude Agent SDK 后，`agent-sidecar` 完全没有接入子代理机制（`query()` 没传 `agents`，没有 `.claude/agents/`，`allowedTools` 也没显式放行 `Agent`），且 `mapper.ts` 对子代理内部消息（`parent_tool_use_id`）毫无处理——如果子代理真的被调用，其内部产生的文本/工具调用会原样串进主对话流，跟主线程消息混在一起。本设计补上这块能力，并把它做成 provider-agnostic 的，为未来接入的其他 agent provider（各自有自己的子代理机制）预留同样的展示层。

## 背景

参考 [SDK 子代理文档](https://code.claude.com/docs/en/agent-sdk/subagents-in-the-sdk)：

- 子代理通过一个叫 `Agent` 的工具调用触发（Claude Code v2.1.63 之前叫 `Task`；当前 SDK 版本的 `tool_use` 块里发 `"Agent"`，但 `system:init` 工具列表和 `permission_denials` 里仍可能是 `"Task"`，需要两个都认）。
- 即使不定义任何自定义 `AgentDefinition`，Claude 也能调用内置的 `general-purpose` 子代理——这是本设计 v1 唯一依赖的子代理角色。
- 子代理有独立的上下文窗口，只有其最终消息以 `Agent` 工具的 `tool_result` 形式返回给父代理；子代理内部的中间消息通过同一个 `query()` 消息流下发，但每条都带有 `parent_tool_use_id` 字段标记归属。
- 官方 Claude Code CLI 自己的默认 UX 也**不**展示子代理内部的实时活动，只展示"调用中 → 最终结果"——这不是能力缺失，是有意的上下文隔离设计。

核对当前代码：
- `agent-sidecar/src/index.ts` 的 `query()` 选项里没有 `allowedTools`，意味着 `Agent`/`Task` 工具调用会像其他工具一样落进 `canUseTool` 回调，弹权限确认框——这不符合 SDK 文档"在 `allowedTools` 里加 `Agent` 以自动批准子代理调用"的推荐用法。
- `agent-sidecar/src/mapper.ts` 的 `mapSdkMessage` 完全没检查 `msg.parent_tool_use_id`，子代理内部消息目前会被当成主线程消息处理——这是一个待修的潜在 bug，独立于本设计是否落地都存在。
- `src-tauri/src/sidecar.rs` 把 sidecar 输出的每行 JSON 反序列化成不带类型的 `serde_json::Value` 原样转发，不关心具体 `type`——跟 `tasks_update` 落地时的结论一致，**本设计不需要改动 Rust 层**。

## 方案：子代理调用吞成两态事件，不做内部活动直播

评估过三种做法：

1. **最小改动**：只加 `allowedTools`，子代理的 `tool_use`/`tool_result` 走现有通用 `tool_use_start`/`tool_result` 通道。问题：前端会看到 `"Agent"`/`"Task"` 这种 Anthropic 内部工具名及其改名历史，换 provider 时这套渲染逻辑不可复用，违反"核心协议不出现 provider 专属字段"的红线。
2. **全量还原嵌套实时流**：把子代理内部的 `parent_tool_use_id` 消息也转成事件，前端递归渲染成嵌套卡片。问题：工作量最大，而且**超出了 Claude Code CLI 自己的默认行为**（官方默认也只展示"调用中 → 结果"两态，不直播内部过程）。
3.（**采纳**）**干净的 provider-agnostic 两态卡片**：`agent-sidecar` 里新增 `SubagentTracker`，把 `Agent`/`Task` 这两个 Anthropic 专属工具名完全吞掉，只对外吐语义化的 `subagent_start`/`subagent_end` 事件；子代理内部消息（带 `parent_tool_use_id` 的）直接在 `mapSdkMessage` 入口过滤掉，不转发。成本接近方案 1，但协议干净——将来别的 provider 的 sidecar 只要也吐这两个事件，UI 和核心协议一行不用改。嵌套实时展示可以作为独立的 v2 增量扩展，不影响这版协议。

v1 范围明确**不**引入自定义 `AgentDefinition`（比如预置一个 `code-reviewer` 角色），只启用 SDK 内置的 `general-purpose` 子代理——没有产品侧证据表明现在需要哪些专门角色，按 YAGNI 原则留到有需求时再加。

## 改动范围

### `agent-sidecar/src/types.ts`
`ChatEvent` 联合类型新增两支：

```ts
| { type: "subagent_start"; id: string; agentName: string; description: string }
| { type: "subagent_end"; id: string; result: string; is_error: boolean }
```

`is_error` 沿用 `tool_result` 的既有命名（贴近 Anthropic tool_result 的原始字段名）；`agentName`/`description` 是新概念，用 camelCase（跟 `TaskItem.activeForm` 的既有风格一致）。

### `agent-sidecar/src/subagents.ts`（新建）
仿照 `tasks.ts` 的 `TaskTracker` 风格：

```ts
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]); // CC v2.1.63 把 Task 改名成 Agent，两个都认

/** 跟踪 Claude Agent SDK 的子代理调用（Agent/Task 工具），对外只吐 provider-agnostic 的
 *  subagent_start/subagent_end 事件。 */
export class SubagentTracker {
  private active = new Set<string>();

  static isSubagentTool(name: string): boolean {
    return SUBAGENT_TOOL_NAMES.has(name);
  }

  /** tool_use 到达时调用：agentName/description 从 input 里立即可得，不用等 tool_result。 */
  handleToolUse(id: string, input: unknown): { agentName: string; description: string } {
    this.active.add(id);
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const agentName = typeof record.subagent_type === "string" ? record.subagent_type : "agent";
    const description = typeof record.description === "string" ? record.description : "";
    return { agentName, description };
  }

  /** 返回 true 表示这个 tool_use_id 属于子代理调用，调用方应发 subagent_end 而非通用 tool_result。 */
  handleToolResult(id: string): boolean {
    return this.active.delete(id);
  }
}
```

### `agent-sidecar/src/mapper.ts`
- `mapSdkMessage` 签名新增第四个参数 `subagents: SubagentTracker`。
- **函数入口新增过滤**：`if (msg.parent_tool_use_id) return;`——子代理内部消息（无论 assistant/user/system）直接丢弃，不转发。这同时修掉了背景里提到的潜在串流 bug。
- assistant 消息的 `tool_use` 分支：`SubagentTracker.isSubagentTool(block.name)` 为真时，调用 `subagents.handleToolUse(block.id, block.input)`，`emit({type:"subagent_start", id: block.id, ...})`；否则维持现有 `TaskTracker`/通用 `tool_use_start` 判断顺序不变。
- user 消息的 `tool_result` 分支：先判断 `subagents.handleToolResult(block.tool_use_id)`，为真则 `emit({type:"subagent_end", id: block.tool_use_id, result: content, is_error: block.is_error ?? false})` 并跳过后续通用/Task 处理；为假才走现有 `TaskTracker`/通用 `tool_result` 逻辑。

### `agent-sidecar/src/index.ts`
- 新增 `const subagentTracker = new SubagentTracker();`（模块级，跟 `taskTracker`/`permMgr` 同生命周期）。
- `query()` 选项新增 `allowedTools: ["Agent", "Task"]`——自动放行子代理调用本身；子代理内部实际执行的 `Read`/`Edit`/`Bash` 等工具不受影响，仍走现有 `canUseTool` 权限弹窗。
- `mapSdkMessage(msg, emit, taskTracker)` 调用处改为 `mapSdkMessage(msg, emit, taskTracker, subagentTracker)`。

### `src/types/chat.ts`
新增 `SubagentBlock`，加入 `ContentBlock` 联合：

```ts
export interface SubagentBlock {
  type: "subagent";
  id: string;
  agentName: string;
  description: string;
  result?: string;
  isError?: boolean;
  isPending: boolean;
}

export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | SubagentBlock;
```

### `src/composables/useChatSession.ts`
`handleChatEvent` 新增两个 case，跟现有 `tool_use_start`/`tool_result` 的处理方式（`getOrCreateAssistant` 推入新块 / `flatMap` 按 id 查找回填）保持一致：

```ts
case "subagent_start": {
  const msg = getOrCreateAssistant(store);
  msg.blocks.push({
    type: "subagent",
    id: e["id"] as string,
    agentName: e["agentName"] as string,
    description: e["description"] as string,
    isPending: true,
  } as SubagentBlock);
  break;
}
case "subagent_end": {
  const block = store.messages
    .flatMap((m) => m.blocks)
    .find((b): b is SubagentBlock => b.type === "subagent" && b.id === e["id"]);
  if (block) {
    block.result = e["result"] as string;
    block.isError = e["is_error"] as boolean;
    block.isPending = false;
  }
  break;
}
```

### `src/components/SubagentCallBlock.vue`（新建）
折叠卡片，结构参照 `ToolCallBlock.vue`（同一套 `--aide-*` 设计 token，不引入新配色）：
- 头部：状态图标（⏳/❌/✅，逻辑跟 `ToolCallBlock` 一致）+ 子代理图标 + `agentName` + `description`（单行截断）。
- 展开后：`isPending` 时显示"子代理执行中…"；否则显示 `result` 纯文本（`<pre>`，不需要 `ToolCallBlock` 那套 Bash/Edit-diff 特判，子代理结果就是一段文字）。

### `src/components/ChatMessage.vue`
- import `SubagentCallBlock`。
- 模板里 `image` 分支旁新增一支：`<SubagentCallBlock v-else-if="block.type === 'subagent'" :block="(block as any)" />`。

## 边界情况

- **`canUseTool` 拒绝了子代理调用**（理论上 `allowedTools` 已自动放行，但保留防御）：SDK 仍会给一条 `tool_result`（`is_error: true`），走正常 `subagent_end` 路径，卡片显示失败结果，不遗留悬空状态。
- **同一轮多个并发子代理调用**：各自的 `tool_use_id` 独立存在 `active` Set，互不干扰，不做并发数限制。
- **子代理执行中用户点"中断"**：现有 interrupt 逻辑不专门处理子代理，卡片会保持 `isPending: true`——这跟现有工具调用（如 `Bash`）被中断时的展示行为一致，不新增逻辑。
- **续接历史会话（resume）**：`SubagentTracker` 是新 sidecar 进程里新建的 `Set`，不做跨进程持久化；如果重启前有子代理调用还没收到 `subagent_end`，历史消息里会遗留一张 `isPending` 卡片——跟 `TaskTracker`、以及现有工具调用中断场景的既有限制一致。
- **`msg.parent_tool_use_id` 过滤依赖 SDK 消息契约**：如果未来 SDK 版本换了字段名标记子代理归属，过滤会失效——按现有项目惯例，这类 SDK 破坏性变更算兼容性问题，不在本设计的防御范围内。

## 范围边界（明确不做）

- 不展示子代理内部的实时活动（文本/工具调用），只做"调用中 → 结果"两态卡片——对齐 Claude Code CLI 官方默认 UX，也是成本最低的选择；如果以后要做嵌套直播，是独立的 v2 增量，不影响这版协议。
- 不新增自定义 `AgentDefinition`（不预置 code-reviewer 之类的专门角色），只启用 SDK 内置的 `general-purpose` 子代理。
- 不改动 Rust 层（`sidecar.rs`/`chat.rs`）——沿用既有 passthrough。
- 不做子代理调用的手动取消/重试交互。
- 不做子代理状态跨会话 resume 的持久化。

## 测试

纯 sidecar + 前端展示层，手动验证：
- 触发一个会促使 Claude 调用 `general-purpose` 子代理的任务（如"帮我调研一下 XXX，用子代理来做"），确认出现一张子代理卡片，展开后看到最终结果文本；消息流里不出现裸的 `"Agent"`/`"Task"` 工具卡片。
- 确认子代理内部的中间消息（如果 SDK 确实下发了 `parent_tool_use_id` 消息）不会串进主对话流——对应 mapper 入口过滤的回归验证。
- 触发多个子代理并发调用，确认各自卡片独立更新、互不串状态。
- 确认 `Agent`/`Task` 调用不再弹权限确认框，但子代理内部实际执行的 `Read`/`Edit`/`Bash` 仍正常弹窗。
- 子代理执行中点"停止"，确认不崩溃，卡片保持 pending 展示。
- 回归：非子代理场景（`Bash`/`Edit`/`Read` 等普通工具卡片、`tasks_update` 面板）渲染不受影响。
