# 子代理全量转发（v2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 aide 的子代理卡片能像原生 Claude CLI 一样展示子代理内部说了什么、想了什么（不只是调用了哪个工具），协议新增两个逐字流式事件，前端卡片从"扁平工具步骤列表"改成"按到达顺序混排文本/thinking/工具调用的时间线"。

**Architecture:** `agent-sidecar/src/mapper.ts` 的 `emitSubagentProgress` 补一个 `stream_event` 分支，把子代理内部的逐字增量（`text_delta`/`thinking_delta`）转成新的 `subagent_text_delta`/`subagent_thinking_delta` 事件（`SubagentTracker` 不用改，扁平 `Set<id>` 单层模型够用）。前端 `SubagentBlock.steps: SubagentStep[]` 改成 `SubagentBlock.entries: SubagentEntry[]`（判别联合，`text`/`thinking`/`tool` 三种），`useChatSession.ts` 按"同类型追加、否则新起一项"累积（跟主线程 `text_delta` 同一套模式），`SubagentCallBlock.vue` 遍历 `entries` 渲染，thinking 用弱化样式区分。

**Tech Stack:** TypeScript + vitest（`agent-sidecar/` 和 `src/` 共用根目录 `vitest.config.ts`），Vue 3 Composition API，Claude Agent SDK。

## Global Constraints

- 依据设计文档 [`docs/superpowers/specs/2026-07-05-subagent-full-transcript-design.md`](../specs/2026-07-05-subagent-full-transcript-design.md)（已提交，commit `083025d`）。
- **明确不支持嵌套子代理**：子代理内部再调用 Task/Agent 工具，按普通工具调用处理（一条 `tool` entry，`toolName: "Agent"`），不递归展开——不是遗漏，是设计里定的范围边界。
- **不加可关闭的开关**：全量转发固定开启，不新增设置项。
- **不改动 Rust 层**（`src-tauri/`）——sidecar 输出的 JSON 是无类型 passthrough，新事件类型对它透明。
- **核心协议保持 provider-agnostic**：新事件命名不出现 Anthropic 专属词汇，跟现有 `subagent_start`/`subagent_progress`/`subagent_end` 风格一致。
- `ChatEvent` 新字段沿用既有混合命名风格：`id`/`delta` snake_case 概念用小写（跟 `text_delta` 一致），事件名本身用 snake_case。
- 包管理器是 pnpm；TS 测试命令 `npx vitest run <path>`；前端类型检查 `npx vue-tsc --noEmit`；`agent-sidecar/` 没有独立类型检查脚本，用 `cd agent-sidecar && npx tsc --noEmit` 手动验证。

---

### Task 1: sidecar 协议扩展 + 逐字流转发

**Files:**
- Modify: `agent-sidecar/src/types.ts`
- Modify: `agent-sidecar/src/mapper.ts`
- Test: `agent-sidecar/src/mapper.test.ts`

**Interfaces:**
- Consumes: 现有 `SubagentTracker.isActive`/`claimModelReport`（`agent-sidecar/src/subagents.ts`，不改）。
- Produces: `ChatEvent` 新增 `{ type: "subagent_text_delta"; id: string; delta: string }` 和 `{ type: "subagent_thinking_delta"; id: string; delta: string }`——Task 2 的 `useChatSession.ts` 会消费这两个事件类型。

- [ ] **Step 1: 写失败的测试**

打开 `agent-sidecar/src/mapper.test.ts`，找到 `describe("mapSdkMessage routing for subagent tools", ...)` 这个 describe 块（第 278-406 行），在最后一个 `it(...)`（"does not attach a placeholder/error-echo model to subagent progress"）之后、describe 块的闭合 `});` 之前，插入：

```ts
  it("forwards a tracked subagent's stream_event text_delta as subagent_text_delta", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
    );
    events.length = 0;
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "a1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "我先看" } },
    };
    mapSdkMessage(delta, (e) => events.push(e), tasks, subagents);
    expect(events).toEqual([{ type: "subagent_text_delta", id: "a1", delta: "我先看" }]);
  });

  it("forwards a tracked subagent's stream_event thinking_delta as subagent_thinking_delta", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
    );
    events.length = 0;
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "a1",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "内心戏" } },
    };
    mapSdkMessage(delta, (e) => events.push(e), tasks, subagents);
    expect(events).toEqual([{ type: "subagent_thinking_delta", id: "a1", delta: "内心戏" }]);
  });

  it("ignores a subagent stream_event for an id we never saw start (defensive)", () => {
    const events: ChatEvent[] = [];
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "ghost",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "不该出现" } },
    };
    mapSdkMessage(delta, (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    expect(events).toEqual([]);
  });

  it("still ignores pure thinking blocks in a full subagent assistant message (already streamed as deltas)", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
    );
    events.length = 0;
    const msg = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { content: [{ type: "thinking", thinking: "内心戏" }] },
    };
    mapSdkMessage(msg, (e) => events.push(e), tasks, subagents);
    expect(events).toEqual([]);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: FAIL —前两个新测试（`subagent_text_delta`/`subagent_thinking_delta`）失败，因为 `ChatEvent` 还没有这两个类型、`emitSubagentProgress` 遇到 `stream_event` 直接被 `msg.type !== "assistant"` 挡掉，`events` 实际是 `[]`，跟期望的非空数组不符。后两个测试（"ignores a subagent stream_event for an id we never saw"、"still ignores pure thinking blocks"）现状代码已经能通过——这是回归锁定测试，不是本次要修的行为，先跑一遍确认它们本来就是绿的即可。

- [ ] **Step 3: 实现最小代码**

打开 `agent-sidecar/src/types.ts`，把：

```ts
  | { type: "subagent_start"; id: string; agentName: string; description: string }
  // 子代理内部的"轻量步骤摘要"：只报它调用了哪个工具+入参，不转发子代理内部的文本/
  // thinking（完整嵌套 transcript 属于 v2，见 mapper.ts 的 forwardSubagentText 讨论）。
  // model 只在第一次能坐实时带一次，之后同一个 id 不再重复。
  | { type: "subagent_progress"; id: string; toolName: string; input: unknown; model?: string }
  | { type: "subagent_end"; id: string; result: string; is_error: boolean }
```

改成：

```ts
  | { type: "subagent_start"; id: string; agentName: string; description: string }
  // 子代理内部逐字流式增量——语义对齐主线程的 text_delta（stream_event 的 text_delta）。
  // thinking 主线程目前不转发，但这条子代理专属通道独立开放，不受此限制（v2）。
  | { type: "subagent_text_delta"; id: string; delta: string }
  | { type: "subagent_thinking_delta"; id: string; delta: string }
  // 子代理内部的"工具调用摘要"：报它调用了哪个工具+入参。model 只在第一次能坐实时
  // 带一次，之后同一个 id 不再重复。
  | { type: "subagent_progress"; id: string; toolName: string; input: unknown; model?: string }
  | { type: "subagent_end"; id: string; result: string; is_error: boolean }
```

打开 `agent-sidecar/src/mapper.ts`，把 `emitSubagentProgress` 函数（第 162-194 行，含它头顶的文档注释）整段替换成：

```ts
/**
 * 子代理内部消息（`parent_tool_use_id` 非空）：转发文本/thinking 的逐字增量（对齐
 * 主线程 stream_event 的粒度），以及工具调用摘要——三者按到达顺序穿插，前端据此
 * 拼出"子代理具体在做什么"的完整时间线（v2，取代 v1 的"只报工具调用摘要"）。
 *
 * 明确不支持嵌套子代理（子代理内部再调用 Task/Agent 工具）：那种情况会落进下面的
 * `toolUses` 分支，当成一次普通工具调用报出去（`toolName: "Agent"`），不递归展开
 * 其内部活动——这个场景现在用不到，按 YAGNI 不做。
 *
 * 顺带在第一条可采信的 assistant 消息上把 `message.model` 带一次，让前端知道这个
 * 子代理具体跑在哪个模型上（`claimModelReport` 保证只报一次）。
 */
function emitSubagentProgress(msg: any, emit: (e: ChatEvent) => void, subagents: SubagentTracker) {
  const parentId = msg.parent_tool_use_id as string;
  if (!subagents.isActive(parentId)) return; // 防御性：理论上不会出现不认识的 id

  // 逐字流式：子代理内部的 text_delta / thinking_delta 增量。
  if (msg.type === "stream_event") {
    const ev = msg.event;
    if (ev?.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        emit({ type: "subagent_text_delta", id: parentId, delta: ev.delta.text });
      } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
        emit({ type: "subagent_thinking_delta", id: parentId, delta: ev.delta.thinking });
      }
    }
    return;
  }

  if (msg.type !== "assistant" || !msg.message?.content) return;
  const toolUses = (msg.message.content as any[]).filter((b) => b.type === "tool_use");
  if (toolUses.length === 0) return; // 纯文本/thinking：已经在 stream_event 阶段逐字发过，这里跳过避免重复渲染
  const model =
    isAdoptableAssistantModel(msg) && subagents.claimModelReport(parentId)
      ? (msg.message.model as string)
      : undefined;
  toolUses.forEach((block, i) => {
    emit({
      type: "subagent_progress",
      id: parentId,
      toolName: block.name,
      input: block.input,
      ...(i === 0 && model ? { model } : {}),
    });
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: PASS（全部测试，包括本文件里原有的其它 describe 块——没有改动它们依赖的代码路径）

- [ ] **Step 5: 类型检查确认无误**

Run: `cd agent-sidecar && npx tsc --noEmit`
Expected: 无输出（无类型错误）

- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/src/types.ts agent-sidecar/src/mapper.ts agent-sidecar/src/mapper.test.ts
git commit -m "$(cat <<'EOF'
feat(sidecar): 转发子代理内部的逐字文本/thinking 增量（v2）

新增 subagent_text_delta/subagent_thinking_delta 两个 ChatEvent，
emitSubagentProgress 补上 stream_event 分支——之前子代理的逐字流式消息
连分支都进不去，被 msg.type !== "assistant" 无条件挡掉。工具调用摘要
（subagent_progress）逻辑不变。不支持嵌套子代理（按 YAGNI 明确排除，
见 docs/superpowers/specs/2026-07-05-subagent-full-transcript-design.md）。
EOF
)"
```

---

### Task 2: 前端数据模型 + useChatSession 事件处理

**Files:**
- Modify: `src/types/chat.ts`
- Modify: `src/composables/useChatSession.ts`
- Test: `src/composables/useChatSession.test.ts`

**Interfaces:**
- Consumes: Task 1 产出的 `subagent_text_delta`/`subagent_thinking_delta` ChatEvent；现有 `subagent_start`/`subagent_progress`/`subagent_end`（本任务改动其字段但不改事件名/触发时机）。
- Produces: `SubagentEntry`（`src/types/chat.ts`）判别联合 `{type:"text";text:string} | {type:"thinking";text:string} | {type:"tool";toolName:string;input:unknown}`；`SubagentBlock.entries: SubagentEntry[]`（取代原 `steps: SubagentStep[]`）——Task 3 的 `SubagentCallBlock.vue` 会遍历这个数组渲染。

- [ ] **Step 1: 写失败的测试**

打开 `src/composables/useChatSession.test.ts`，找到 `describe("useChatSession subagent events", ...)` 这个 describe 块（第 343-413 行），把里面唯一的 `it(...)`（"subagent_start 推入一个 pending 的 subagent 块，subagent_end 按 id 回填结果"，第 352-412 行）整段替换成：

```ts
  it("subagent_start 推入一个 pending 的 subagent 块，subagent_progress/subagent_end 按 id 更新", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("帮我调研一下 XXX");

    emit({
      type: "subagent_start",
      id: "a1",
      agentName: "general-purpose",
      description: "调研 XXX",
      session_id: "uuid-a",
    });
    await flush();

    type SubagentTestBlock = {
      agentName?: string;
      description?: string;
      model?: string;
      entries: { type: string; toolName?: string; input?: unknown; text?: string }[];
      isPending: boolean;
      result?: string;
      isError?: boolean;
    };

    let block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as SubagentTestBlock | undefined;
    expect(block).toMatchObject({ agentName: "general-purpose", description: "调研 XXX", isPending: true, entries: [] });
    expect(block?.result).toBeUndefined();

    emit({
      type: "subagent_progress",
      id: "a1",
      toolName: "Read",
      input: { file_path: "x.ts" },
      model: "claude-sonnet-5-20260101",
      session_id: "uuid-a",
    });
    await flush();

    block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as SubagentTestBlock | undefined;
    expect(block?.entries).toEqual([{ type: "tool", toolName: "Read", input: { file_path: "x.ts" } }]);
    expect(block?.model).toBe("claude-sonnet-5-20260101");

    emit({
      type: "subagent_end",
      id: "a1",
      result: "调研结论：……",
      is_error: false,
      session_id: "uuid-a",
    });
    await flush();

    block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as SubagentTestBlock | undefined;
    expect(block).toMatchObject({ isPending: false, result: "调研结论：……", isError: false });
  });

  it("subagent_text_delta/subagent_thinking_delta 逐字累积，类型切换或穿插工具调用时另起一项", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("帮我调研一下 XXX");
    emit({ type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX", session_id: "uuid-a" });

    emit({ type: "subagent_text_delta", id: "a1", delta: "我", session_id: "uuid-a" });
    emit({ type: "subagent_text_delta", id: "a1", delta: "先看看", session_id: "uuid-a" });
    emit({ type: "subagent_thinking_delta", id: "a1", delta: "要不要先读 README", session_id: "uuid-a" });
    emit({ type: "subagent_progress", id: "a1", toolName: "Read", input: { file_path: "README.md" }, session_id: "uuid-a" });
    emit({ type: "subagent_text_delta", id: "a1", delta: "看完了", session_id: "uuid-a" });
    await flush();

    const block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as
      | { entries: { type: string; text?: string; toolName?: string; input?: unknown }[] }
      | undefined;
    expect(block?.entries).toEqual([
      { type: "text", text: "我先看看" },
      { type: "thinking", text: "要不要先读 README" },
      { type: "tool", toolName: "Read", input: { file_path: "README.md" } },
      { type: "text", text: "看完了" },
    ]);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/composables/useChatSession.test.ts`
Expected: FAIL——第一个测试里 `block?.entries` 是 `undefined`（现在字段还叫 `steps`），跟期望的 `[]`/`[{type:"tool",...}]` 不符；第二个测试里 `subagent_text_delta`/`subagent_thinking_delta` 还没有对应的 `case`，事件被 `switch` 默认忽略，`entries` 始终是 `[]`，跟期望的四项数组不符。

- [ ] **Step 3: 实现最小代码**

打开 `src/types/chat.ts`，把：

```ts
/** 子代理内部的一步——只报工具名+入参（轻量摘要），不含子代理内部的文本/thinking。 */
export interface SubagentStep {
  toolName: string;
  input: unknown;
}

export interface SubagentBlock {
  type: "subagent";
  id: string;
  agentName: string;
  description: string;
  /** 子代理具体跑在哪个模型上——只在 sidecar 第一次坐实时才有值，之后不会变。 */
  model?: string;
  /** 运行期间收到的步骤时间线，按到达顺序追加；用于展开态展示实时进度。 */
  steps: SubagentStep[];
  result?: string;
  isError?: boolean;
  isPending: boolean;
}
```

改成：

```ts
/** 子代理内部时间线上的一项——按到达顺序混排文本/thinking 增量累积的段落，以及
 *  一次完整的工具调用（工具调用没有"增量"概念，一次到位）。 */
export type SubagentEntry =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; toolName: string; input: unknown };

export interface SubagentBlock {
  type: "subagent";
  id: string;
  agentName: string;
  description: string;
  /** 子代理具体跑在哪个模型上——只在 sidecar 第一次坐实时才有值，之后不会变。 */
  model?: string;
  /** 运行期间收到的时间线，按到达顺序追加；用于展开态还原"子代理具体做了什么"。 */
  entries: SubagentEntry[];
  result?: string;
  isError?: boolean;
  isPending: boolean;
}
```

打开 `src/composables/useChatSession.ts`，把顶部的类型 import（第 4-16 行）：

```ts
import type {
  ChatMessage,
  ContextUsage,
  ModelOption,
  PermissionModeOption,
  PermissionRequest,
  RateLimitInfo,
  SubagentBlock,
  TaskItem,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
```

改成：

```ts
import type {
  ChatMessage,
  ContextUsage,
  ModelOption,
  PermissionModeOption,
  PermissionRequest,
  RateLimitInfo,
  SubagentBlock,
  SubagentEntry,
  TaskItem,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
```

在 `finishStreaming` 函数（第 179-182 行）后面新增一个辅助函数：

```ts
/** 子代理逐字增量累积：跟主线程 text_delta 同一套模式——最后一项同类型就原地追加，
 *  否则另起一项（类型切换，或被一次工具调用打断了连续的文本/thinking 段落）。 */
function appendSubagentTextEntry(block: SubagentBlock, kind: "text" | "thinking", delta: string) {
  const last = block.entries[block.entries.length - 1];
  if (kind === "text") {
    if (last && last.type === "text") {
      last.text += delta;
      return;
    }
    block.entries.push({ type: "text", text: delta });
    return;
  }
  if (last && last.type === "thinking") {
    last.text += delta;
    return;
  }
  block.entries.push({ type: "thinking", text: delta });
}
```

找到 `case "subagent_start":`（第 390-401 行）：

```ts
    case "subagent_start": {
      const msg = getOrCreateAssistant(store);
      msg.blocks.push({
        type: "subagent",
        id: e["id"] as string,
        agentName: e["agentName"] as string,
        description: e["description"] as string,
        steps: [],
        isPending: true,
      } as SubagentBlock);
      break;
    }
```

改成：

```ts
    case "subagent_start": {
      const msg = getOrCreateAssistant(store);
      msg.blocks.push({
        type: "subagent",
        id: e["id"] as string,
        agentName: e["agentName"] as string,
        description: e["description"] as string,
        entries: [],
        isPending: true,
      } as SubagentBlock);
      break;
    }
```

找到 `case "subagent_progress":`（第 402-411 行）：

```ts
    case "subagent_progress": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        block.steps.push({ toolName: e["toolName"] as string, input: e["input"] });
        if (e["model"]) block.model = e["model"] as string;
      }
      break;
    }
```

改成（在它之前插入两个新 case，处理逐字增量）：

```ts
    case "subagent_text_delta":
    case "subagent_thinking_delta": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        appendSubagentTextEntry(block, e["type"] === "subagent_text_delta" ? "text" : "thinking", e["delta"] as string);
      }
      break;
    }
    case "subagent_progress": {
      const block = store.messages
        .flatMap((m) => m.blocks)
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        block.entries.push({ type: "tool", toolName: e["toolName"] as string, input: e["input"] });
        if (e["model"]) block.model = e["model"] as string;
      }
      break;
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/composables/useChatSession.test.ts`
Expected: PASS（全部测试，包括文件里其它 describe 块——没有改动它们依赖的代码路径）

- [ ] **Step 5: 类型检查确认无误**

Run: `npx vue-tsc --noEmit`
Expected: 无输出（无类型错误）。注意：这一步此时会因为 `src/components/SubagentCallBlock.vue` 还在用旧的 `block.steps` 而报错——那是 Task 3 要修的地方，如果这里报错且报错位置在 `SubagentCallBlock.vue`，说明本任务改动本身没问题，继续往下做 Task 3 即可；如果报错位置在 `useChatSession.ts` 或 `chat.ts`，才是本任务需要修的问题。

- [ ] **Step 6: Commit**

```bash
git add src/types/chat.ts src/composables/useChatSession.ts src/composables/useChatSession.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): SubagentBlock.steps 改成有序 entries，接入逐字流式事件

SubagentEntry 判别联合（text/thinking/tool）取代原来只报工具调用的
SubagentStep；useChatSession 新增 subagent_text_delta/subagent_thinking_delta
两个 case，累积逻辑跟主线程 text_delta 同一套模式（同类型追加、否则新起
一项）。subagent_progress 改成 push 到 entries 而不是 steps。
EOF
)"
```

---

### Task 3: SubagentCallBlock.vue — entries 时间线渲染

**Files:**
- Modify: `src/components/SubagentCallBlock.vue`

**Interfaces:**
- Consumes: Task 2 产出的 `SubagentBlock.entries: SubagentEntry[]`；`src/utils/toolSummary.ts` 的 `summarizeToolInput(name, input): string`（不改）。
- Produces: 无（叶子 UI 组件，是这条功能链路的终点）。

这个组件没有自动化测试（项目里没有引入 `@vue/test-utils`，所有 `.vue` 组件都是手动验证——跟仓库现状一致），所以本任务不走"写失败测试"环节，直接给出完整新文件内容 + 类型检查 + 手动验证。

- [ ] **Step 1: 替换整个文件内容**

把 `src/components/SubagentCallBlock.vue`的全部内容替换成：

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import type { SubagentBlock, SubagentEntry } from "@/types/chat";
import { summarizeToolInput } from "@/utils/toolSummary";

const props = defineProps<{ block: SubagentBlock }>();
const expanded = ref(false);

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});

function stepSummary(entry: Extract<SubagentEntry, { type: "tool" }>): string {
  return summarizeToolInput(entry.toolName, entry.input);
}
</script>

<template>
  <div class="subagent-block">
    <button class="subagent-header" @click="expanded = !expanded">
      <span class="subagent-status">{{ statusIcon }}</span>
      <span class="subagent-icon">🧩</span>
      <span class="subagent-name">{{ block.agentName }}</span>
      <span v-if="block.model" class="subagent-model" :title="`子代理使用的模型：${block.model}`">{{ block.model }}</span>
      <span class="subagent-desc">{{ block.description }}</span>
      <span v-if="block.isPending && block.entries.length" class="subagent-step-count">
        {{ block.entries.length }} 项
      </span>
      <span class="subagent-chevron">{{ expanded ? "▲" : "▼" }}</span>
    </button>
    <div v-if="expanded" class="subagent-body">
      <ol v-if="block.entries.length" class="subagent-entries">
        <li v-for="(entry, i) in block.entries" :key="i" class="subagent-entry" :class="`entry-${entry.type}`">
          <template v-if="entry.type === 'tool'">
            <span class="step-tool">{{ entry.toolName }}</span>
            <span class="step-summary">{{ stepSummary(entry) }}</span>
          </template>
          <p v-else class="entry-text-body">{{ entry.text }}</p>
        </li>
      </ol>
      <pre v-if="block.result" class="subagent-result">{{ block.result }}</pre>
      <div v-else-if="!block.entries.length" class="subagent-pending">子代理执行中…</div>
    </div>
  </div>
</template>

<style scoped>
/* 左侧色条 + 独立底色，让子代理卡片一眼区别于普通 ToolCallBlock（同尺寸但视觉上
 * 明确"这是一个嵌套的子进程"，而不是主流程里的一次工具调用）。 */
.subagent-block {
  margin: 4px 0;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  border-left: 3px solid var(--aide-accent);
  background: color-mix(in srgb, var(--aide-accent) 6%, var(--aide-bg-raised));
  font-size: 12px;
  overflow: hidden;
}

.subagent-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--aide-text-muted);
  text-align: left;
  transition: background 0.1s;
}

.subagent-header:hover {
  background: color-mix(in srgb, var(--aide-accent) 10%, transparent);
  color: var(--aide-text-primary);
}

.subagent-status {
  flex-shrink: 0;
  font-size: 11px;
}

.subagent-icon {
  flex-shrink: 0;
  font-size: 11px;
}

.subagent-name {
  font-weight: 600;
  color: var(--aide-accent);
  flex-shrink: 0;
}

.subagent-model {
  flex-shrink: 0;
  font-size: 10px;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  border-radius: 4px;
  padding: 0 4px;
}

.subagent-desc {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}

.subagent-step-count {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--aide-text-muted);
  font-style: italic;
}

.subagent-chevron {
  flex-shrink: 0;
  font-size: 9px;
}

.subagent-body {
  border-top: 1px solid var(--aide-border);
  padding: 6px 8px;
}

.subagent-entries {
  margin: 0 0 6px;
  padding-left: 16px;
  max-height: 240px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.subagent-entry {
  font-size: 11px;
}

.subagent-entry.entry-tool {
  display: flex;
  gap: 6px;
}

.step-tool {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--aide-text-secondary);
}

.step-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'Cascadia Code', 'Consolas', monospace;
  color: var(--aide-text-muted);
}

.entry-text-body {
  margin: 0;
  white-space: pre-wrap;
  color: var(--aide-text-secondary);
}

/* thinking 弱化样式，呼应原生 CLI 里 thinking 的视觉弱化处理——一眼能跟正式回复
 * 的文本区分开，不用去读内容就知道"这是内心戏还是真的在说话"。 */
.subagent-entry.entry-thinking .entry-text-body {
  color: var(--aide-text-muted);
  font-style: italic;
  opacity: 0.85;
}

.subagent-result {
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--aide-text-secondary);
  margin: 0;
}

.subagent-pending {
  font-style: italic;
  color: var(--aide-text-muted);
}
</style>
```

主要改动点：`block.steps` → `block.entries`；`subagent-step-count` 的文案从"N 步"改成"N 项"（现在混了文本/thinking/工具三种，不只是"步骤"）；body 里从固定渲染 `<li>{{step.toolName}}...` 改成按 `entry.type` 分支渲染，`tool` 类型保留原来的两栏摘要样式，`text`/`thinking` 共用 `.entry-text-body` 段落样式，`thinking` 再叠一层弱化样式（`color`/`font-style: italic`/`opacity`）。`ChatMessage.vue` 里已有的 `<SubagentCallBlock v-else-if="block.type === 'subagent'" ...>` 接入点不用改——组件对外的 `props.block` 类型不变（还是 `SubagentBlock`），只是内部字段变了。

- [ ] **Step 2: 类型检查确认无误**

Run: `npx vue-tsc --noEmit`
Expected: 无输出（无类型错误）。这一步会同时验证 Task 2 遗留的类型检查（见 Task 2 Step 5 的提示）现在也过了。

- [ ] **Step 3: 手动验证（无自动化 UI 测试覆盖，比照项目里其他 Vue 组件的现状）**

Run: `pnpm tauri dev`（或项目既有的 `dev.ps1`）。在应用里发一条会让 `general-purpose` 子代理先说点什么再调用工具的消息，例如：

> 用子代理帮我调研一下当前项目用了哪些第三方库，调研前先说说你打算怎么做

确认：
1. 出现一张子代理卡片，头部显示 agentName + 描述 + 运行中图标；卡片默认收起。
2. 展开卡片：能看到文本、（如果模型输出了 thinking）弱化斜体的 thinking、工具调用摘要按实际发生的顺序穿插排列，不是分成三段互不相干的区块。
3. 子代理跑完后，展开态在时间线下方追加显示 `result` 文本，`isPending` 变化正确（状态图标从 ⏳ 变成 ✅ 或 ❌）。
4. 收起状态下让子代理继续跑一会儿（不展开卡片），确认界面没有明显卡顿——间接验证"收起时不产生额外渲染开销"的设计假设。
5. 回归：触发一次普通工具调用（非子代理场景，如直接用 `Bash`），确认 `ToolCallBlock.vue` 渲染跟以前一样，不受本次改动影响。

- [ ] **Step 4: Commit**

```bash
git add src/components/SubagentCallBlock.vue
git commit -m "$(cat <<'EOF'
feat(chat): 子代理卡片改成 entries 时间线渲染（v2 全量转发落地）

遍历 SubagentBlock.entries 按到达顺序渲染 text/thinking/tool 三种条目，
thinking 用弱化斜体样式区分。取代之前只渲染扁平工具步骤列表的 v1 展示，
子代理内部说了什么、想了什么现在都能在展开态看到。
EOF
)"
```

---

## Self-Review Notes

- **Spec 覆盖**：设计文档里的三处改动范围（sidecar 协议+转发 / 前端数据模型+事件处理 / 组件渲染）分别对应 Task 1/2/3；"不支持嵌套"体现在 Task 1 的 `emitSubagentProgress` 文档注释和 Global Constraints；"不加开关"体现在 Global Constraints，三个任务都没有引入任何设置项；"渲染量分析"（收起不渲染）体现在 Task 3 Step 3 的手动验证第 4 点。
- **Placeholder 扫描**：三个任务的代码块均为可直接使用的完整代码，没有 TBD/"仿照 Task N"之类的占位描述。
- **类型一致性核对**：`SubagentEntry`（Task 2 定义）在 Task 3 的 `Extract<SubagentEntry, { type: "tool" }>` 里被正确引用；`appendSubagentTextEntry(block: SubagentBlock, kind: "text" | "thinking", delta: string)` 的调用点（`case "subagent_text_delta"`/`"subagent_thinking_delta"`）参数顺序和类型一致；`ChatEvent` 的 `subagent_text_delta`/`subagent_thinking_delta`（Task 1 定义）字段名 `id`/`delta` 与 Task 2 消费处 `e["id"]`/`e["delta"]` 对应一致。
