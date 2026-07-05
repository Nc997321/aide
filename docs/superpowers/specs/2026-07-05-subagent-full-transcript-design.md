# 子代理全量转发（v2）— 设计

## 背景

[v1 子代理支持设计](./2026-07-03-subagent-support-design.md)（已实现）把子代理调用吞成"调用中 → 结果"两态卡片，明确把"直播子代理内部实时活动"列为范围边界之外的 v2 增量。之后的迭代里，`mapper.ts` 又加了一层轻量补丁——`subagent_progress` 事件，把子代理内部**调用了哪个工具+入参**报给前端（原因见 `mapper.ts` 注释：子代理跑得久时，`useSessionState` 的 90 秒软超时靠"任意事件重置计时器"判断卡死，v1 的零事件会被误判成 stalled）。但子代理内部**说了什么、想了什么**（文本/thinking）仍然被无条件丢弃——`emitSubagentProgress` 一进函数就判断 `msg.type !== "assistant"`，子代理的 `stream_event`（逐字增量）连分支都进不去。

现状对比原生 Claude CLI：CLI 默认前台运行、把子代理内部的完整消息流（文本/thinking/工具调用）整条缩进展开渲染；aide 现在只有工具调用摘要，用户反馈"看不到子代理具体在干什么"。本设计补上文本+thinking 这最后一块，称为 v2。

## 需求确认（brainstorming 过程中定的范围）

- **内容范围**：文本 + thinking 都转发（对齐原生 CLI 完整度），不只是工具调用摘要。
- **流式粒度**：逐字真流式，跟主线程 `text_delta` 同等体验，不是等一整条 assistant 消息到齐再批量推。
- **开关**：不加可关闭选项，固定发全量——sidecar 本身跟主代理共享同一份 token 额度，多转发只是前端渲染/IPC 传输量变大，不影响成本，没必要多一个开关状态组合。
- **嵌套子代理**：**不支持**。子代理内部如果真的又调用了 Task/Agent 工具（递归嵌套），按普通工具调用处理（显示一步 `toolName: "Agent"`，不展开其内部），这个场景当前用不到，明确排除，按 YAGNI 原则不做。

## 方案

评估过三种协议形状（详细论证见 brainstorming 过程）：

1. **细粒度事件流，前端按 id 定位卡片**（采纳）：新增 `subagent_text_delta` / `subagent_thinking_delta` 两个逐字事件，`subagent_start`/`subagent_progress`/`subagent_end` 不变。子代理卡片内部从"扁平工具步骤列表"改成"有序时间线"（文本/thinking/工具调用按到达顺序混排），跟主线消息的 `ContentBlock[]` 是同一种设计语言，只是作用域收窄在卡片内部。
2. **sidecar 整体拼树后整块快照推送**：实现简单，但每个 token 都要重发整块内容，跟"逐字真流式"直接冲突，且 IPC 体量随对话变长自乘。否决。
3. **单独开一条原始 SDK 事件通道，前端自己复刻 Anthropic 消息形状**：直接违反项目架构红线（Claude 专属逻辑只能留在 `agent-sidecar/`，前端/Rust 必须 provider-agnostic）。否决。

## 改动范围

### `agent-sidecar/src/types.ts`

`ChatEvent` 新增两支，`subagent_start`/`subagent_progress`/`subagent_end` 不变（不需要 `parentId`——不支持嵌套，父级恒定是主消息）：

```ts
| { type: "subagent_text_delta"; id: string; delta: string }
| { type: "subagent_thinking_delta"; id: string; delta: string }
```

### `agent-sidecar/src/subagents.ts`

不改。`SubagentTracker` 的扁平 `Set<id>` 模型本来就是单层，够用——不支持嵌套意味着不需要升级成树结构。

### `agent-sidecar/src/mapper.ts`

`emitSubagentProgress` 新增一个分支，处理路由顺序上已经会到达这里、但目前被隐式丢弃的 `stream_event`：

```ts
if (msg.type === "stream_event") {
  const ev = msg.event;
  if (ev?.delta?.type === "text_delta" && ev.delta.text) {
    emit({ type: "subagent_text_delta", id: parentId, delta: ev.delta.text });
  } else if (ev?.delta?.type === "thinking_delta" && ev.delta.thinking) {
    emit({ type: "subagent_thinking_delta", id: parentId, delta: ev.delta.thinking });
  }
  return;
}
```

原有"完整 assistant 消息只处理 `tool_use`"逻辑不变——`.filter(b => b.type === "tool_use")` 天然跳过 text/thinking 块（已经在 `stream_event` 阶段逐字发过，避免重复渲染），无需额外 dedup 代码。

已知既有小缺口（v1 就有，v2 不修）：`model` 字段目前挂在"第一个工具调用"上报；如果某轮子代理整轮只说话不调工具，这一轮不会报 `model`。不在本设计修复范围。

### `src/types/chat.ts`

`SubagentBlock.steps: SubagentStep[]`（扁平工具步骤）改成有序 `entries`，新增一种"混排"结构：

```ts
export type SubagentEntry =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; toolName: string; input: unknown };

export interface SubagentBlock {
  type: "subagent";
  id: string;
  agentName: string;
  description: string;
  model?: string;
  entries: SubagentEntry[];   // 按到达顺序混排文本/thinking/工具调用
  result?: string;
  isError?: boolean;
  isPending: boolean;
}
```

### `src/composables/useChatSession.ts`

`subagent_text_delta`/`subagent_thinking_delta` 两个新 case：按 `id` 找到卡片，若 `entries` 最后一项类型相同就原地追加文本（累积同一条流式段落），否则新起一项——跟主线程文本累积同一套模式。`subagent_progress` 改成往 `entries` 末尾 push 一条 `{type:"tool", ...}`，而不是单独的 `steps` 数组。

### `src/components/SubagentCallBlock.vue`

展开态从"渲染 `steps` 列表"改成"遍历 `entries`"：`tool` 项复用现有工具步骤的一行摘要样式；`text` 项按普通段落渲染；`thinking` 项用弱化样式（斜体/更浅的文字颜色）区分，呼应原生 CLI 里 thinking 的视觉弱化处理。折叠/展开机制不变（默认收起，`v-if` 语义，逐字流式更新只发生在数据层，收起时不产生任何 DOM patch，跟展开与否无关的是数据本身持续累积在内存里）。

## 渲染量 / 性能考量

- **收起态**：`v-if="expanded"` 保持现状语义——收起时新增的逐字事件只是普通响应式数据更新，没有挂载的渲染函数订阅它们，不产生 DOM 开销。跟 v1 相比几乎没有额外渲染成本。
- **展开态**：局部 patch，跟主线程文本流式是同一档开销量级，不会因为"这是子代理"而更重。
- **内存**：子代理话说得越多，卡片累积的 `entries` 越大，即使从未展开过也会持续占内存——这是必要的数据保留（否则展开时看到空白），本设计不加截断/上限（YAGNI，等真的有人反馈内存问题再处理）。
- **多个并发子代理**：各自的展开状态独立（现状已是如此），互不影响。

## 边界情况

- **子代理内部嵌套调用 Task/Agent 工具**：不做特殊展开，落到 `entries` 里的普通 `tool` 项（`toolName: "Agent"`），这是现有 `emitSubagentProgress` 的天然兜底行为，不用专门写代码，也不会报错或丢事件。
- **子代理执行中断/进程重启/resume**：沿用 v1 已有边界（卡片保持 `isPending`，不做跨会话持久化），本设计不改变这些既有限制。
- **`canUseTool` 拒绝子代理调用**：沿用 v1 路径（`subagent_end` 带 `is_error: true`），不受影响。

## 范围边界（明确不做）

- 不支持子代理嵌套子代理的递归展示（v3 若真有场景再评估）。
- 不加可关闭的开关设置。
- 不改动 Rust 层（`sidecar.rs`/`chat.rs`）——纯 JSON passthrough，新事件类型对它透明。
- 不修复"整轮不调工具就不报 model"这个 v1 既有缺口。
- 不做 `entries` 的内存上限/截断。

## 测试（手动验证）

- 触发一个会让 `general-purpose` 子代理产出较长文本再调用工具的任务，展开卡片确认：文本先逐字出现、工具调用穿插在正确的时间位置、thinking（如果模型输出了）以弱化样式呈现，顺序与实际发生顺序一致。
- 确认收起状态下（不展开卡片）子代理跑完整个任务，UI 没有明显卡顿/掉帧（间接验证"收起不渲染"的假设）。
- 触发多个并发子代理调用，确认各自 `entries` 独立累积、不串条目。
- 子代理内部触发一次普通工具权限确认弹窗，确认不受本设计影响（`fromSubagent` 路径不变）。
- 回归：非子代理场景（主线程文本流式、`tasks_update` 面板、普通工具卡片）渲染不受影响。
- 回归：v1 的"调用中 → 结果"两态、`subagent_progress` 工具摘要在旧版本行为上不退化（该走的还走，只是现在中间还能看到文本/thinking）。
