# 子代理（Subagent）支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `agent-sidecar` 正确接入 Claude Agent SDK 的子代理调用（`Agent`/`Task` 工具），并把它转成 provider-agnostic 的两态事件（`subagent_start`/`subagent_end`），在聊天界面里渲染成一张可展开的卡片。

**Architecture:** `agent-sidecar/src/subagents.ts` 新增 `SubagentTracker`，跟踪子代理调用的生命周期并识别子代理内部消息（`parent_tool_use_id`）；`mapper.ts` 用它把 `Agent`/`Task` 工具吞掉、转成语义化事件，并过滤掉子代理内部消息不让其串入主对话流；`index.ts` 把 `Agent`/`Task` 加入 `allowedTools` 自动放行子代理调用本身。前端 `src/types/chat.ts` 新增 `SubagentBlock` 内容块类型，`useChatSession.ts` 按 id 路由 `subagent_start`/`subagent_end` 事件，新组件 `SubagentCallBlock.vue` 渲染折叠卡片。

**Tech Stack:** TypeScript + vitest（`agent-sidecar/` 和 `src/` 共用根目录 `vitest.config.ts`），Vue 3 Composition API，Claude Agent SDK。

## Global Constraints

- 核心协议（`ChatEvent`/`ContentBlock`）不能出现 Anthropic 专属字符串（`"Agent"`/`"Task"`/`subagent_type` 等）——这些只能停留在 `agent-sidecar` 内部，对外只吐 `subagent_start`/`subagent_end`。
- 不改动 `src-tauri/`（Rust 层对 sidecar 输出做无类型 passthrough，不需要感知新事件类型）。
- `ChatEvent` 新字段命名沿用项目既有混合风格：`is_error` 用 snake_case（贴近 `tool_result` 的既有字段名），`agentName`/`description` 等新概念字段用 camelCase（贴近 `TaskItem.activeForm` 的既有风格）。
- v1 范围明确不做：子代理内部活动的嵌套实时展示、自定义 `AgentDefinition`、子代理调用的取消/重试交互、跨会话 resume 持久化。
- 所有 TS 改动跑 `npm test`（仓库根目录 `vitest run`，`vitest.config.ts` 同时覆盖 `src/**/*.test.ts` 和 `agent-sidecar/src/**/*.test.ts`）。
- `agent-sidecar/` 没有独立的类型检查脚本，`index.ts` 改动用 `cd agent-sidecar && npx tsc --noEmit` 手动验证。

---

### Task 1: SubagentTracker（子代理生命周期跟踪器）

**Files:**
- Create: `agent-sidecar/src/subagents.ts`
- Test: `agent-sidecar/src/subagents.test.ts`

**Interfaces:**
- Consumes: 无（纯逻辑单元，不依赖其他任务的产物）
- Produces: `export class SubagentTracker { static isSubagentTool(name: string): boolean; handleToolUse(id: string, input: unknown): { agentName: string; description: string }; handleToolResult(id: string): boolean; }`——Task 2（mapper.ts）会实例化并调用这三个成员。

- [ ] **Step 1: 写失败测试**

创建 `agent-sidecar/src/subagents.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { SubagentTracker } from "./subagents.js";

describe("SubagentTracker.isSubagentTool", () => {
  it("recognizes Agent and Task (pre/post CC v2.1.63 rename)", () => {
    expect(SubagentTracker.isSubagentTool("Agent")).toBe(true);
    expect(SubagentTracker.isSubagentTool("Task")).toBe(true);
  });

  it("rejects other tool names", () => {
    expect(SubagentTracker.isSubagentTool("Bash")).toBe(false);
    expect(SubagentTracker.isSubagentTool("TaskCreate")).toBe(false);
  });
});

describe("SubagentTracker lifecycle", () => {
  it("extracts agentName/description from input on handleToolUse", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", {
      subagent_type: "general-purpose",
      description: "调研 XXX 的实现方式",
    });
    expect(result).toEqual({ agentName: "general-purpose", description: "调研 XXX 的实现方式" });
  });

  it("defaults agentName to 'agent' and description to '' when input is missing fields", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", {});
    expect(result).toEqual({ agentName: "agent", description: "" });
  });

  it("defaults safely when input is not an object", () => {
    const t = new SubagentTracker();
    const result = t.handleToolUse("u1", null);
    expect(result).toEqual({ agentName: "agent", description: "" });
  });

  it("handleToolResult returns true and clears a tracked id", () => {
    const t = new SubagentTracker();
    t.handleToolUse("u1", { subagent_type: "general-purpose", description: "x" });
    expect(t.handleToolResult("u1")).toBe(true);
    // 同一个 id 第二次不再算 tracked（已被消费）
    expect(t.handleToolResult("u1")).toBe(false);
  });

  it("handleToolResult returns false for an id it never saw", () => {
    const t = new SubagentTracker();
    expect(t.handleToolResult("ghost")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run agent-sidecar/src/subagents.test.ts`
Expected: FAIL（`Cannot find module './subagents.js'` 或类似——文件还不存在）

- [ ] **Step 3: 写最小实现**

创建 `agent-sidecar/src/subagents.ts`：

```ts
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]); // CC v2.1.63 把 Task 改名成 Agent，两个都认

/** 跟踪 Claude Agent SDK 的子代理调用（Agent/Task 工具），对外只暴露 provider-agnostic 的
 *  agentName/description/是否仍在跟踪中——mapper 层据此生成 subagent_start/subagent_end 事件。 */
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

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run agent-sidecar/src/subagents.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/subagents.ts agent-sidecar/src/subagents.test.ts
git commit -m "$(cat <<'EOF'
feat(sidecar): 新增 SubagentTracker 跟踪子代理调用生命周期

对外只暴露 agentName/description/是否仍在跟踪，不泄漏 Anthropic 的
Agent/Task 工具名，为 mapper 层生成 provider-agnostic 事件打基础。
EOF
)"
```

---

### Task 2: ChatEvent 协议扩展 + mapper 路由

**Files:**
- Modify: `agent-sidecar/src/types.ts`
- Modify: `agent-sidecar/src/mapper.ts`
- Modify: `agent-sidecar/src/mapper.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SubagentTracker`（`isSubagentTool`/`handleToolUse`/`handleToolResult`）。
- Produces: `ChatEvent` 新增 `{ type: "subagent_start"; id: string; agentName: string; description: string }` 和 `{ type: "subagent_end"; id: string; result: string; is_error: boolean }`；`mapSdkMessage` 签名变为 `(msg: any, emit: (e: ChatEvent) => void, tasks: TaskTracker, subagents: SubagentTracker) => void`——Task 3（index.ts）依赖这个新签名，Task 4/5（前端）依赖这两个事件的字段名。

- [ ] **Step 1: 写失败测试（先扩协议类型，测试才能类型检查通过）**

打开 `agent-sidecar/src/types.ts`，在 `ChatEvent` 联合类型里，`| { type: "tool_result"; ... }` 那一支后面插入两支新事件：

```ts
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "subagent_start"; id: string; agentName: string; description: string }
  | { type: "subagent_end"; id: string; result: string; is_error: boolean }
  | { type: "permission_request"; id: string; name: string; input: unknown }
```

（即在原有 `tool_result` 和 `permission_request` 两行之间插入这两行新联合成员，其余行不变。）

用完整内容覆盖 `agent-sidecar/src/mapper.test.ts`（新增 `SubagentTracker` 相关用例，并给所有现有 `mapSdkMessage(...)` 调用点补上第四个参数）：

```ts
import { describe, it, expect } from "vitest";
import { mapSdkMessage } from "./mapper.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import type { ChatEvent } from "./types.js";

function assistantToolUse(id: string, name: string, input: unknown, parentToolUseId?: string) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
  };
}

function assistantText(text: string, parentToolUseId?: string) {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
  };
}

function userToolResult(toolUseId: string, content: string, isError = false) {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  };
}

describe("mapSdkMessage routing for Task tools", () => {
  it("does not emit tool_use_start for TaskCreate", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks, subagents);
    expect(events).toEqual([]);
  });

  it("still emits tool_use_start for non-task tools", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(assistantToolUse("t1", "Bash", { command: "ls" }), (e) => events.push(e), tasks, subagents);
    expect(events).toEqual([{ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" } }]);
  });

  it("emits tasks_update after TaskCreate's tool_result resolves, without a generic tool_result", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks, subagents);
    mapSdkMessage(
      userToolResult("t1", JSON.stringify({ task: { id: "task-1", subject: "写测试" } })),
      (e) => events.push(e),
      tasks,
      subagents,
    );
    expect(events).toEqual([
      { type: "tasks_update", tasks: [{ id: "task-1", subject: "写测试", status: "pending", activeForm: undefined }] },
    ]);
  });

  it("emits tasks_update when a later TaskUpdate patches an existing task", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks, subagents);
    mapSdkMessage(
      userToolResult("t1", JSON.stringify({ task: { id: "task-1", subject: "写测试" } })),
      (e) => events.push(e),
      tasks,
      subagents,
    );
    events.length = 0;
    mapSdkMessage(
      assistantToolUse("t2", "TaskUpdate", { taskId: "task-1", status: "in_progress" }),
      (e) => events.push(e),
      tasks,
      subagents,
    );
    expect(events).toEqual([
      { type: "tasks_update", tasks: [{ id: "task-1", subject: "写测试", status: "in_progress", activeForm: undefined }] },
    ]);
  });

  it("still emits generic tool_result for non-task tool results", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(userToolResult("t9", "ok"), (e) => events.push(e), tasks, subagents);
    expect(events).toEqual([{ type: "tool_result", id: "t9", content: "ok", is_error: false }]);
  });
});

describe("mapSdkMessage routing for subagent tools", () => {
  it("emits subagent_start instead of tool_use_start for the Agent tool", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
    );
    expect(events).toEqual([
      { type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX" },
    ]);
  });

  it("recognizes the pre-rename Task tool name too", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Task", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
    );
    expect(events).toEqual([
      { type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX" },
    ]);
  });

  it("emits subagent_end instead of a generic tool_result when the tracked id resolves", () => {
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
    mapSdkMessage(userToolResult("a1", "调研结论：……"), (e) => events.push(e), tasks, subagents);
    expect(events).toEqual([
      { type: "subagent_end", id: "a1", result: "调研结论：……", is_error: false },
    ]);
  });

  it("drops messages carrying parent_tool_use_id (subagent-internal messages)", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    mapSdkMessage(assistantText("子代理内部的思考文本", "a1"), (e) => events.push(e), tasks, subagents);
    mapSdkMessage(assistantToolUse("inner1", "Read", { file_path: "x.ts" }, "a1"), (e) => events.push(e), tasks, subagents);
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: FAIL（`mapSdkMessage` 现在只接受 3 个参数，类型/运行时都对不上；新增的 subagent 相关断言也会失败）

- [ ] **Step 3: 写最小实现**

打开 `agent-sidecar/src/mapper.ts`，在文件顶部 `import { TaskTracker } from "./tasks.js";` 下面新增一行：

```ts
import { SubagentTracker } from "./subagents.js";
```

把 `mapSdkMessage` 函数整体替换成：

```ts
export function mapSdkMessage(
  msg: any,
  emit: (e: ChatEvent) => void,
  tasks: TaskTracker,
  subagents: SubagentTracker,
) {
  if (msg.parent_tool_use_id) return; // 子代理内部消息：v1 不做嵌套直播，直接丢弃

  if (msg.type === "system" && msg.subtype === "init") {
    emit({ type: "session_init", session_id: msg.session_id });
    return;
  }

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        emit({ type: "text_delta", delta: block.text });
      } else if (block.type === "tool_use") {
        if (SubagentTracker.isSubagentTool(block.name)) {
          const { agentName, description } = subagents.handleToolUse(block.id, block.input);
          emit({ type: "subagent_start", id: block.id, agentName, description });
        } else if (TaskTracker.isTaskTool(block.name)) {
          if (tasks.handleToolUse(block.id, block.name, block.input)) {
            emit({ type: "tasks_update", tasks: tasks.snapshot() });
          }
        } else {
          emit({ type: "tool_use_start", id: block.id, name: block.name, input: block.input });
        }
      }
    }
    return;
  }

  if (msg.type === "user" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? "").join("")
          : String(block.content ?? "");
        if (subagents.handleToolResult(block.tool_use_id)) {
          emit({ type: "subagent_end", id: block.tool_use_id, result: content, is_error: block.is_error ?? false });
          continue;
        }
        const outcome = tasks.handleToolResult(block.tool_use_id, content);
        if (outcome.changed) {
          emit({ type: "tasks_update", tasks: tasks.snapshot() });
        }
        if (!outcome.tracked) {
          emit({ type: "tool_result", id: block.tool_use_id, content, is_error: block.is_error ?? false });
        }
      }
    }
    return;
  }

  if (msg.type === "result") {
    const modelUsage = msg.modelUsage as Record<string, {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }> | undefined;
    const entries = modelUsage ? Object.values(modelUsage) : [];
    let usage: TurnUsage | null = null;
    if (entries.length > 0) {
      usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
      for (const m of entries) {
        usage.inputTokens += m.inputTokens ?? 0;
        usage.outputTokens += m.outputTokens ?? 0;
        usage.cacheReadInputTokens += m.cacheReadInputTokens ?? 0;
        usage.cacheCreationInputTokens += m.cacheCreationInputTokens ?? 0;
        usage.costUsd += m.costUSD ?? 0;
      }
    }
    emit({
      type: "message_stop",
      stop_reason: msg.subtype === "success" ? "end_turn" : msg.subtype,
      total_cost_usd: msg.total_cost_usd ?? null,
      usage,
    });
    return;
  }
}
```

（这段替换了原文件第 34～103 行的整个函数体，函数以上的 `buildUserMessage` 及其导入不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: PASS（14 个用例全绿：5 个 Task 工具用例 + 4 个新 subagent 用例，其中新文件还应包含原本已有的其他 describe block，如果 mapper.test.ts 里还有别的既有测试块，保持不动即可）

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/types.ts agent-sidecar/src/mapper.ts agent-sidecar/src/mapper.test.ts
git commit -m "$(cat <<'EOF'
feat(sidecar): mapper 把 Agent/Task 工具路由给 SubagentTracker

ChatEvent 新增 subagent_start/subagent_end 两态事件；子代理内部消息
（parent_tool_use_id 非空）在入口直接过滤，避免串进主对话流。
EOF
)"
```

---

### Task 3: index.ts 接入 SubagentTracker + 自动放行子代理调用

**Files:**
- Modify: `agent-sidecar/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `SubagentTracker`；Task 2 的新 `mapSdkMessage` 四参数签名。
- Produces: 无（这是运行时接线的终点，后续任务不依赖它导出的符号）。

- [ ] **Step 1: 修改导入和实例化**

打开 `agent-sidecar/src/index.ts`，在 `import { TaskTracker } from "./tasks.js";` 下面新增：

```ts
import { SubagentTracker } from "./subagents.js";
```

在 `const taskTracker = new TaskTracker();`（第 25 行）下面新增：

```ts
const subagentTracker = new SubagentTracker();
```

- [ ] **Step 2: 放行子代理调用本身**

在 `query()` 的 `options` 对象里，`settingSources: ["project", "user"],` 这一行下面新增：

```ts
            allowedTools: ["Agent", "Task"],
```

（子代理内部实际执行的 `Read`/`Edit`/`Bash` 等工具名不在这个列表里，继续走 `canUseTool` 正常弹权限确认框，不受影响。）

- [ ] **Step 3: 传入新参数**

把 `mapSdkMessage(msg, emit, taskTracker);` 那一行改成：

```ts
          mapSdkMessage(msg, emit, taskTracker, subagentTracker);
```

- [ ] **Step 4: 类型检查确认无误**

Run: `cd agent-sidecar && npx tsc --noEmit`
Expected: 无输出（无类型错误）

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/index.ts
git commit -m "$(cat <<'EOF'
feat(sidecar): 入口接入 SubagentTracker，自动放行子代理调用

allowedTools 加入 Agent/Task，跳过子代理调用本身的权限弹窗；
子代理内部实际执行的工具调用仍走正常权限流程。
EOF
)"
```

---

### Task 4: 前端协议类型 — SubagentBlock

**Files:**
- Modify: `src/types/chat.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `export interface SubagentBlock { type: "subagent"; id: string; agentName: string; description: string; result?: string; isError?: boolean; isPending: boolean; }`，并入 `ContentBlock` 联合——Task 5（`useChatSession.ts`）和 Task 6（`SubagentCallBlock.vue`/`ChatMessage.vue`）都依赖这个类型和字段名。

- [ ] **Step 1: 新增类型**

打开 `src/types/chat.ts`，在 `ImageBlock` interface 后面（`ContentBlock` 联合定义之前）插入：

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
```

把 `export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock;` 改成：

```ts
export type ContentBlock = TextBlock | ToolCallBlock | ImageBlock | SubagentBlock;
```

- [ ] **Step 2: 类型检查确认无误**

Run: `npx vue-tsc --noEmit`
Expected: 无输出（无类型错误——这一步只加了类型，没有代码消费它，`ContentBlock` 联合扩大不会破坏现有 `switch`/`v-if` 穷尽性检查，因为 Vue 模板的 `v-else-if` 不做穷尽性校验）

- [ ] **Step 3: 提交**

```bash
git add src/types/chat.ts
git commit -m "feat(chat): 新增 SubagentBlock 内容块类型，镜像 sidecar 的 subagent_start/subagent_end 事件"
```

---

### Task 5: useChatSession 接入 subagent_start/subagent_end 事件

**Files:**
- Modify: `src/composables/useChatSession.ts`
- Modify: `src/composables/useChatSession.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `SubagentBlock` 类型；sidecar 发出的 `subagent_start`/`subagent_end` 事件（字段名见 Task 2）。
- Produces: `chat.messages.value` 里的 assistant 消息 `blocks` 数组会包含 `SubagentBlock` 元素——Task 6 的 `ChatMessage.vue` 依赖这个已经存在于 `blocks` 里的数据形状（不需要 `useChatSession` 额外导出新字段，跟 `tool_call` 块的既有消费方式一致）。

- [ ] **Step 1: 写失败测试**

打开 `src/composables/useChatSession.test.ts`，在文件顶部的 import 区域确认已有 `emit`/`flush` 辅助函数（已存在，不用新增）。在文件末尾、最后一个 `describe` block 的闭合 `});` 之后追加一个新的 `describe` block：

```ts
describe("useChatSession subagent events", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
  });

  it("subagent_start 推入一个 pending 的 subagent 块，subagent_end 按 id 回填结果", async () => {
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

    let block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as
      | { agentName: string; description: string; isPending: boolean; result?: string }
      | undefined;
    expect(block).toMatchObject({ agentName: "general-purpose", description: "调研 XXX", isPending: true });
    expect(block?.result).toBeUndefined();

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
      .find((b) => b.type === "subagent") as
      | { isPending: boolean; result?: string; isError?: boolean }
      | undefined;
    expect(block).toMatchObject({ isPending: false, result: "调研结论：……", isError: false });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/useChatSession.test.ts`
Expected: FAIL（`subagent_start`/`subagent_end` 事件目前在 `handleChatEvent` 的 `switch` 里没有对应 `case`，`blocks` 里不会出现 `type === "subagent"` 的元素，断言 `block` 为 `undefined` 导致 `toMatchObject` 报错）

- [ ] **Step 3: 写最小实现**

打开 `src/composables/useChatSession.ts`，在顶部的类型导入里把：

```ts
import type {
  ChatMessage,
  ContextUsage,
  ModelOption,
  PermissionRequest,
  TaskItem,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
```

改成（新增 `SubagentBlock`）：

```ts
import type {
  ChatMessage,
  ContextUsage,
  ModelOption,
  PermissionRequest,
  SubagentBlock,
  TaskItem,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
```

在 `handleChatEvent` 的 `switch` 语句里，找到 `case "tasks_update": { ... break; }`（第 209～212 行），在它后面插入两个新 case：

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
        .find((b): b is SubagentBlock => b.type === "subagent" && (b as SubagentBlock).id === e["id"]);
      if (block) {
        block.result = e["result"] as string;
        block.isError = e["is_error"] as boolean;
        block.isPending = false;
      }
      break;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/useChatSession.test.ts`
Expected: PASS（含新用例在内全部通过）

- [ ] **Step 5: 提交**

```bash
git add src/composables/useChatSession.ts src/composables/useChatSession.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): useChatSession 接入 subagent_start/subagent_end 事件

按现有 tool_use_start/tool_result 的路由方式（推入新块 / 按 id 回填）
处理子代理生命周期事件。
EOF
)"
```

---

### Task 6: SubagentCallBlock.vue 组件 + 接入 ChatMessage.vue

**Files:**
- Create: `src/components/SubagentCallBlock.vue`
- Modify: `src/components/ChatMessage.vue`

**Interfaces:**
- Consumes: Task 4 的 `SubagentBlock` 类型；Task 5 产出的、已经出现在 `message.blocks` 里的 `SubagentBlock` 数据。
- Produces: 无（叶子 UI 组件，是这条功能链路的终点）。

- [ ] **Step 1: 创建组件**

创建 `src/components/SubagentCallBlock.vue`：

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import type { SubagentBlock } from "@/types/chat";

const props = defineProps<{ block: SubagentBlock }>();
const expanded = ref(false);

const statusIcon = computed(() => {
  if (props.block.isPending) return "⏳";
  if (props.block.isError) return "❌";
  return "✅";
});
</script>

<template>
  <div class="subagent-block">
    <button class="subagent-header" @click="expanded = !expanded">
      <span class="subagent-status">{{ statusIcon }}</span>
      <span class="subagent-icon">🧩</span>
      <span class="subagent-name">{{ block.agentName }}</span>
      <span class="subagent-desc">{{ block.description }}</span>
      <span class="subagent-chevron">{{ expanded ? "▲" : "▼" }}</span>
    </button>
    <div v-if="expanded" class="subagent-body">
      <pre v-if="block.result" class="subagent-result">{{ block.result }}</pre>
      <div v-else class="subagent-pending">子代理执行中…</div>
    </div>
  </div>
</template>

<style scoped>
.subagent-block {
  margin: 4px 0;
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-bg-raised);
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
  background: var(--aide-surface-hover);
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
  color: var(--aide-text-secondary);
  flex-shrink: 0;
}

.subagent-desc {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aide-text-muted);
}

.subagent-chevron {
  flex-shrink: 0;
  font-size: 9px;
}

.subagent-body {
  border-top: 1px solid var(--aide-border);
  padding: 6px 8px;
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

- [ ] **Step 2: 接入 ChatMessage.vue**

打开 `src/components/ChatMessage.vue`，在 `import ToolCallBlock from "./ToolCallBlock.vue";` 下面新增：

```ts
import SubagentCallBlock from "./SubagentCallBlock.vue";
```

在模板里，找到：

```html
        <img
          v-else-if="block.type === 'image'"
          :src="`data:${(block as any).mediaType};base64,${(block as any).data}`"
          class="msg-image"
          alt="附图"
        />
```

在它后面（`</template>` 内、`v-for` 循环体结束之前）新增一支：

```html
        <SubagentCallBlock
          v-else-if="block.type === 'subagent'"
          :block="(block as any)"
        />
```

- [ ] **Step 3: 类型检查确认无误**

Run: `npx vue-tsc --noEmit`
Expected: 无输出（无类型错误）

- [ ] **Step 4: 手动验证（无自动化 UI 测试覆盖，比照项目里其他 Vue 组件的现状）**

Run: `npm run dev`（或项目既有的 `dev.ps1`），在应用里发一条会触发 Claude 调用 `general-purpose` 子代理的消息（例如"帮我用子代理调研一下当前项目用了哪些第三方库"），确认：
- 出现一张带 🧩 图标的折叠卡片，标题显示 `general-purpose` 和任务描述；
- 展开后 pending 时显示"子代理执行中…"，完成后显示最终结果文本；
- 消息流里不出现裸的 `"Agent"`/`"Task"` 通用工具卡片；
- 子代理内部若触发了 `Read`/`Edit`/`Bash` 等工具，这些工具仍正常弹出权限确认框（验证 Task 3 的 `allowedTools` 没有误放行子代理内部动作）。

Expected: 上述四点全部符合预期。

- [ ] **Step 5: 提交**

```bash
git add src/components/SubagentCallBlock.vue src/components/ChatMessage.vue
git commit -m "$(cat <<'EOF'
feat(chat): 新增子代理调用折叠卡片并接入 ChatMessage

复用 ToolCallBlock 的折叠卡片视觉语言，展示子代理 agentName/description
和最终结果，不做内部活动的嵌套实时展示（v1 范围边界）。
EOF
)"
```
