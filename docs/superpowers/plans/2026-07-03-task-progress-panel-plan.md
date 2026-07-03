# 任务进度展示面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拦截 Claude Agent SDK 的 Task 工具（`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`），在 agent-sidecar 内累加状态并发出 provider-agnostic 的 `tasks_update` 快照事件，前端渲染一个独立的实时任务清单面板。

**Architecture:** `agent-sidecar/src/tasks.ts` 新增 `TaskTracker` 累加器，`mapper.ts` 把这 4 个工具名路由给它而不再发通用 `tool_use_start`/`tool_result`；每次状态变化后发一次全量 `TaskItem[]` 快照（约定同现有 `context_usage`/`models_available`）。前端 `useChatSession.ts` 整体覆盖存进 `store.tasks`，新组件 `TaskListPanel.vue` 挂在 `ChatPanel.vue` 消息列表上方展示。Rust 层（`src-tauri/`）已确认对 `chat-event` 完全 passthrough（`sidecar.rs:103-113` 只反序列化成 `serde_json::Value` 转发），本功能不涉及 Rust 改动。

**Tech Stack:** TypeScript（agent-sidecar，Node ESM）+ Vue 3 Composition API（前端）+ Vitest（单测，扩展根 `vitest.config.ts` 覆盖 `agent-sidecar/src`）。

## Global Constraints

- Provider-agnostic 核心协议：对外的 `TaskItem`/`ChatEvent.tasks_update` 类型不得出现 `TaskCreate`/`TaskUpdate` 等 Anthropic 专属工具名字符串或字段。
- Claude 专属逻辑（识别这 4 个工具名、解析 `tool_result` 里的 `{task:{id,subject}}` 结构）只允许存在于 `agent-sidecar/` 内。
- 不做任务清单跨会话 resume / 应用重启的持久化，只维护当前 sidecar 进程存活期间的内存态。
- 不处理旧版 `TodoWrite`（已确认当前安装的 SDK 版本 0.3.197 默认使用 Task 工具，代码里也没有设置 `CLAUDE_CODE_ENABLE_TASKS=0`）。
- 不改动 `src-tauri/`（Rust 层对 `chat-event` 完全 passthrough，已核实无需感知新事件类型）。
- 面板不提供任务的增删改交互，纯展示模型自己上报的进度；不做自动折叠/淡出动画。

依据文档：`docs/superpowers/specs/2026-07-03-task-progress-panel-design.md`

---

### Task 1: TaskTracker 状态机（agent-sidecar 核心逻辑）

**Files:**
- Modify: `vitest.config.ts`
- Modify: `agent-sidecar/src/types.ts`
- Create: `agent-sidecar/src/tasks.ts`
- Test: `agent-sidecar/src/tasks.test.ts`

**Interfaces:**
- Produces: `export interface TaskItem { id: string; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }`（`agent-sidecar/src/types.ts`）；`ChatEvent` 新增 `{ type: "tasks_update"; tasks: TaskItem[] }`。
- Produces: `export class TaskTracker`（`agent-sidecar/src/tasks.ts`），静态方法 `TaskTracker.isTaskTool(name: string): boolean`，实例方法 `handleToolUse(id: string, name: string, input: unknown): boolean`、`handleToolResult(id: string, content: string): { tracked: boolean; changed: boolean }`、`snapshot(): TaskItem[]`。Task 2 直接消费这个类。

- [ ] **Step 1: 扩展 vitest 配置以覆盖 agent-sidecar**

`vitest.config.ts` 当前内容：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

改成：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts", "agent-sidecar/src/**/*.test.ts"] },
});
```

- [ ] **Step 2: 在 `agent-sidecar/src/types.ts` 里新增 `TaskItem` 类型和 `tasks_update` 事件**

当前 `ChatEvent` 联合类型（第 17-28 行）：

```ts
// Sidecar → Rust（每行一个 JSON，写入 stdout）
export type ChatEvent =
  | { type: "session_init"; session_id: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: string; is_error: boolean }
  | { type: "permission_request"; id: string; name: string; input: unknown }
  | { type: "permission_cancelled"; id: string }
  | { type: "message_stop"; stop_reason: string; total_cost_usd: number | null; usage: TurnUsage | null }
  | { type: "models_available"; models: ModelOption[]; current: string }
  | { type: "context_usage"; total_tokens: number; max_tokens: number; percentage: number }
  | { type: "error"; message: string };
```

在 `ModelOption` interface（第 12-15 行）后面、`ChatEvent` 声明前面插入：

```ts
/** 待办任务项——provider-agnostic，任何 agent 的"任务追踪"能力都映射成这个形状。 */
export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}
```

并在 `ChatEvent` 联合类型里追加一行（放在 `context_usage` 之后、`error` 之前）：

```ts
  | { type: "tasks_update"; tasks: TaskItem[] }
```

- [ ] **Step 3: 写失败的单测 `agent-sidecar/src/tasks.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { TaskTracker } from "./tasks.js";

describe("TaskTracker.isTaskTool", () => {
  it("recognizes the 4 Task tool names", () => {
    expect(TaskTracker.isTaskTool("TaskCreate")).toBe(true);
    expect(TaskTracker.isTaskTool("TaskUpdate")).toBe(true);
    expect(TaskTracker.isTaskTool("TaskGet")).toBe(true);
    expect(TaskTracker.isTaskTool("TaskList")).toBe(true);
  });

  it("rejects other tool names", () => {
    expect(TaskTracker.isTaskTool("Bash")).toBe(false);
    expect(TaskTracker.isTaskTool("Edit")).toBe(false);
  });
});

describe("TaskTracker create lifecycle", () => {
  it("does not add to the snapshot until the create's tool_result resolves", () => {
    const t = new TaskTracker();
    const changed = t.handleToolUse("u1", "TaskCreate", { subject: "写测试", activeForm: "正在写测试" });
    expect(changed).toBe(false);
    expect(t.snapshot()).toEqual([]);
  });

  it("adds a pending task once the create result carries an id", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "写测试", activeForm: "正在写测试" });
    const outcome = t.handleToolResult("u1", JSON.stringify({ task: { id: "task-1", subject: "写测试" } }));
    expect(outcome).toEqual({ tracked: true, changed: true });
    expect(t.snapshot()).toEqual([
      { id: "task-1", subject: "写测试", status: "pending", activeForm: "正在写测试" },
    ]);
  });

  it("silently drops a create whose result is not valid JSON", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "写测试" });
    const outcome = t.handleToolResult("u1", "not json");
    expect(outcome).toEqual({ tracked: true, changed: false });
    expect(t.snapshot()).toEqual([]);
  });

  it("silently drops a create result missing task.id", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "写测试" });
    const outcome = t.handleToolResult("u1", JSON.stringify({ task: { subject: "写测试" } }));
    expect(outcome).toEqual({ tracked: true, changed: false });
    expect(t.snapshot()).toEqual([]);
  });
});

describe("TaskTracker update lifecycle", () => {
  function createResolved(t: TaskTracker, toolUseId: string, taskId: string, subject: string) {
    t.handleToolUse(toolUseId, "TaskCreate", { subject });
    t.handleToolResult(toolUseId, JSON.stringify({ task: { id: taskId, subject } }));
  }

  it("patches status via the canonical taskId field", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "task-1", "写测试");
    const changed = t.handleToolUse("u2", "TaskUpdate", { taskId: "task-1", status: "in_progress" });
    expect(changed).toBe(true);
    expect(t.snapshot()).toEqual([
      { id: "task-1", subject: "写测试", status: "in_progress", activeForm: undefined },
    ]);
  });

  it("falls back to id/task_id and active_form when the canonical names are absent", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "task-1", "写测试");
    const changed = t.handleToolUse("u2", "TaskUpdate", {
      id: "task-1",
      status: "in_progress",
      active_form: "正在写测试",
    });
    expect(changed).toBe(true);
    expect(t.snapshot()).toEqual([
      { id: "task-1", subject: "写测试", status: "in_progress", activeForm: "正在写测试" },
    ]);
  });

  it("removes the task when status is deleted", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "task-1", "写测试");
    const changed = t.handleToolUse("u2", "TaskUpdate", { taskId: "task-1", status: "deleted" });
    expect(changed).toBe(true);
    expect(t.snapshot()).toEqual([]);
  });

  it("ignores an update for an unknown taskId", () => {
    const t = new TaskTracker();
    const changed = t.handleToolUse("u1", "TaskUpdate", { taskId: "ghost", status: "completed" });
    expect(changed).toBe(false);
    expect(t.snapshot()).toEqual([]);
  });

  it("ignores an unrecognized status value but still resolves the update", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "task-1", "写测试");
    const changed = t.handleToolUse("u2", "TaskUpdate", { taskId: "task-1", status: "bogus" });
    expect(changed).toBe(true);
    expect(t.snapshot()[0].status).toBe("pending");
  });
});

describe("TaskTracker read-only tools", () => {
  it("TaskGet/TaskList do not change the snapshot and their results are swallowed", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "写测试" });
    t.handleToolResult("u1", JSON.stringify({ task: { id: "task-1", subject: "写测试" } }));
    const before = t.snapshot();

    expect(t.handleToolUse("u2", "TaskList", {})).toBe(false);
    expect(t.handleToolResult("u2", JSON.stringify({ tasks: before }))).toEqual({ tracked: true, changed: false });
    expect(t.snapshot()).toEqual(before);
  });
});

describe("TaskTracker unrelated tool results", () => {
  it("reports tracked:false for an id it never saw", () => {
    const t = new TaskTracker();
    expect(t.handleToolResult("unknown", "ok")).toEqual({ tracked: false, changed: false });
  });
});
```

- [ ] **Step 4: 跑测试，确认失败**

Run: `npx vitest run agent-sidecar/src/tasks.test.ts`
Expected: FAIL（`agent-sidecar/src/tasks.js` 找不到 / 模块不存在）

- [ ] **Step 5: 实现 `agent-sidecar/src/tasks.ts`**

```ts
import type { TaskItem } from "./types.js";

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"]);
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

interface PendingCreate {
  subject: string;
  activeForm?: string;
}

export interface ToolResultOutcome {
  /** true 表示这个 tool_use_id 属于 Task 工具，调用方不应再转发通用 tool_result 事件。 */
  tracked: boolean;
  /** true 表示任务清单发生了变化，调用方应该发一次 tasks_update 快照。 */
  changed: boolean;
}

/** 累加 Claude Agent SDK 的 Task 工具（TaskCreate/TaskUpdate/TaskGet/TaskList）
 *  状态，对外只暴露 provider-agnostic 的 TaskItem 快照。 */
export class TaskTracker {
  private tasks = new Map<string, TaskItem>();
  private pendingCreates = new Map<string, PendingCreate>();
  /** 记录这 4 个工具的 tool_use_id，好在对应 tool_result 到达时判断要不要吞掉。 */
  private trackedIds = new Set<string>();

  static isTaskTool(name: string): boolean {
    return TASK_TOOL_NAMES.has(name);
  }

  /** 返回 true 时调用方应该发一次 tasks_update 快照。 */
  handleToolUse(id: string, name: string, input: unknown): boolean {
    this.trackedIds.add(id);
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

    if (name === "TaskCreate") {
      const activeForm = typeof record.activeForm === "string" ? record.activeForm : undefined;
      this.pendingCreates.set(id, { subject: String(record.subject ?? ""), activeForm });
      return false; // taskId 要等 tool_result 才知道
    }

    if (name === "TaskUpdate") {
      const taskId = (record.taskId ?? record.id ?? record.task_id) as string | undefined;
      if (!taskId) return false;
      const existing = this.tasks.get(taskId);
      if (!existing) return false; // 没见过的 id，防御性丢弃

      if (record.status === "deleted") {
        this.tasks.delete(taskId);
        return true;
      }
      if (typeof record.status === "string" && TASK_STATUSES.has(record.status)) {
        existing.status = record.status as TaskItem["status"];
      }
      if (typeof record.subject === "string") existing.subject = record.subject;
      const activeForm = record.activeForm ?? record.active_form;
      if (typeof activeForm === "string") existing.activeForm = activeForm;
      return true;
    }

    return false; // TaskGet / TaskList：只读，不产生状态变化
  }

  /** tracked=false 表示这不是任务工具的结果，调用方应照旧转发通用 tool_result；
   *  changed=true 表示状态变了，调用方应该发一次 tasks_update 快照。 */
  handleToolResult(id: string, content: string): ToolResultOutcome {
    if (!this.trackedIds.delete(id)) return { tracked: false, changed: false };

    const pending = this.pendingCreates.get(id);
    if (!pending) return { tracked: true, changed: false }; // TaskUpdate/TaskGet/TaskList 的结果
    this.pendingCreates.delete(id);

    try {
      const parsed = JSON.parse(content) as { task?: { id?: string; subject?: string } };
      const taskId = parsed.task?.id;
      if (!taskId) return { tracked: true, changed: false };
      this.tasks.set(taskId, {
        id: taskId,
        subject: parsed.task?.subject ?? pending.subject,
        status: "pending",
        activeForm: pending.activeForm,
      });
      return { tracked: true, changed: true };
    } catch {
      return { tracked: true, changed: false }; // 解析失败静默丢弃，不影响主对话流
    }
  }

  snapshot(): TaskItem[] {
    return [...this.tasks.values()];
  }
}
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `npx vitest run agent-sidecar/src/tasks.test.ts`
Expected: PASS（全部 11 个 `it` 用例通过）

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts agent-sidecar/src/types.ts agent-sidecar/src/tasks.ts agent-sidecar/src/tasks.test.ts
git commit -m "feat(tasks): 新增 TaskTracker 累加 Claude Task 工具状态"
```

---

### Task 2: mapper.ts 把 Task 工具路由给 TaskTracker

**Files:**
- Modify: `agent-sidecar/src/mapper.ts`
- Test: `agent-sidecar/src/mapper.test.ts`

**Interfaces:**
- Consumes: `TaskTracker`（Task 1），方法 `isTaskTool`/`handleToolUse`/`handleToolResult`/`snapshot`。
- Produces: `mapSdkMessage(msg: any, emit: (e: ChatEvent) => void, tasks: TaskTracker): void`（签名新增第三个参数，Task 3 的 `index.ts` 消费这个新签名）。

- [ ] **Step 1: 写失败的单测 `agent-sidecar/src/mapper.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mapSdkMessage } from "./mapper.js";
import { TaskTracker } from "./tasks.js";
import type { ChatEvent } from "./types.js";

function assistantToolUse(id: string, name: string, input: unknown) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
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
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks);
    expect(events).toEqual([]);
  });

  it("still emits tool_use_start for non-task tools", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    mapSdkMessage(assistantToolUse("t1", "Bash", { command: "ls" }), (e) => events.push(e), tasks);
    expect(events).toEqual([{ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" } }]);
  });

  it("emits tasks_update after TaskCreate's tool_result resolves, without a generic tool_result", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks);
    mapSdkMessage(
      userToolResult("t1", JSON.stringify({ task: { id: "task-1", subject: "写测试" } })),
      (e) => events.push(e),
      tasks,
    );
    expect(events).toEqual([
      { type: "tasks_update", tasks: [{ id: "task-1", subject: "写测试", status: "pending", activeForm: undefined }] },
    ]);
  });

  it("emits tasks_update when a later TaskUpdate patches an existing task", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks);
    mapSdkMessage(
      userToolResult("t1", JSON.stringify({ task: { id: "task-1", subject: "写测试" } })),
      (e) => events.push(e),
      tasks,
    );
    events.length = 0;
    mapSdkMessage(
      assistantToolUse("t2", "TaskUpdate", { taskId: "task-1", status: "in_progress" }),
      (e) => events.push(e),
      tasks,
    );
    expect(events).toEqual([
      { type: "tasks_update", tasks: [{ id: "task-1", subject: "写测试", status: "in_progress", activeForm: undefined }] },
    ]);
  });

  it("still emits generic tool_result for non-task tool results", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    mapSdkMessage(userToolResult("t9", "ok"), (e) => events.push(e), tasks);
    expect(events).toEqual([{ type: "tool_result", id: "t9", content: "ok", is_error: false }]);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: FAIL（`mapSdkMessage` 目前只接受 2 个参数，调用点类型/行为不匹配，且 `tasks_update` 分支尚未实现）

- [ ] **Step 3: 修改 `agent-sidecar/src/mapper.ts`**

文件顶部 import 改成：

```ts
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { ChatEvent, ImageAttachment, TurnUsage } from "./types.js";
import { TaskTracker } from "./tasks.js";
```

`mapSdkMessage` 函数签名和 tool_use/tool_result 分支改成：

```ts
export function mapSdkMessage(msg: any, emit: (e: ChatEvent) => void, tasks: TaskTracker) {
  if (msg.type === "system" && msg.subtype === "init") {
    emit({ type: "session_init", session_id: msg.session_id });
    return;
  }

  if (msg.type === "assistant" && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === "text") {
        emit({ type: "text_delta", delta: block.text });
      } else if (block.type === "tool_use") {
        if (TaskTracker.isTaskTool(block.name)) {
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

（`buildUserMessage` 函数保持不变，不用改。）

- [ ] **Step 4: 跑测试，确认通过**

Run: `npx vitest run agent-sidecar/src/mapper.test.ts`
Expected: PASS（全部 5 个 `it` 用例通过）

- [ ] **Step 5: 跑一遍 Task 1 的测试，确认没有回归**

Run: `npx vitest run agent-sidecar/src`
Expected: PASS（`tasks.test.ts` + `mapper.test.ts` 共 16 个用例全部通过）

- [ ] **Step 6: Commit**

```bash
git add agent-sidecar/src/mapper.ts agent-sidecar/src/mapper.test.ts
git commit -m "feat(tasks): mapper 把 Task 工具路由给 TaskTracker"
```

---

### Task 3: index.ts 接入 TaskTracker 实例

**Files:**
- Modify: `agent-sidecar/src/index.ts`

**Interfaces:**
- Consumes: `TaskTracker`（Task 1）、`mapSdkMessage(msg, emit, tasks)` 新签名（Task 2）。
- Produces: 无新增导出——这是纯粹的进程入口接入，Task 4/5 不依赖这个文件的任何导出。

- [ ] **Step 1: 修改 import 和实例化**

`agent-sidecar/src/index.ts` 第 5-6 行：

```ts
import { PermissionManager } from "./permissions.js";
import { mapSdkMessage, buildUserMessage } from "./mapper.js";
```

改成：

```ts
import { PermissionManager } from "./permissions.js";
import { TaskTracker } from "./tasks.js";
import { mapSdkMessage, buildUserMessage } from "./mapper.js";
```

第 22-23 行：

```ts
const queue = new MessageQueue();
const permMgr = new PermissionManager();
```

改成：

```ts
const queue = new MessageQueue();
const permMgr = new PermissionManager();
const taskTracker = new TaskTracker();
```

- [ ] **Step 2: 修改 `mapSdkMessage` 调用点**

第 97 行：

```ts
          mapSdkMessage(msg, emit);
```

改成：

```ts
          mapSdkMessage(msg, emit, taskTracker);
```

- [ ] **Step 3: 类型检查 + 构建校验**

Run: `cd agent-sidecar && npx tsc --noEmit`
Expected: 无报错输出（退出码 0）

Run: `cd agent-sidecar && npm run build`
Expected: esbuild 成功输出 `dist/sidecar.js`，无报错

- [ ] **Step 4: Commit**

```bash
git add agent-sidecar/src/index.ts
git commit -m "feat(tasks): sidecar 入口接入 TaskTracker"
```

---

### Task 4: 前端类型镜像 + useChatSession 状态接入

**Files:**
- Modify: `src/types/chat.ts`
- Modify: `src/composables/useChatSession.ts`

**Interfaces:**
- Produces: `src/types/chat.ts` 新增 `export interface TaskItem { id: string; subject: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }`（前端侧类型，与 `agent-sidecar/src/types.ts` 里的同名 interface 镜像，两边独立维护，不共享 import——这是项目既有约定，`ModelOption`/`ContextUsage` 也是同样两边各自定义）。
- Produces: `useChatSession(...)` 返回值新增 `tasks: ComputedRef<TaskItem[]>`。Task 5 的 `App.vue`/`ChatPanel.vue` 消费这个字段。

- [ ] **Step 1: 在 `src/types/chat.ts` 新增 `TaskItem`**

当前 `ContextUsage` interface（第 40-45 行）：

```ts
/** 当前会话的上下文窗口用量——每轮结束后由 sidecar 刷新一次。 */
export interface ContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
}
```

紧接着（在 `ChatMessage` interface 之前）插入：

```ts
/** 待办任务项——provider-agnostic，跟 agent-sidecar/src/types.ts 里的同名类型镜像。 */
export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}
```

- [ ] **Step 2: 修改 `src/composables/useChatSession.ts` 的类型 import**

第 4-12 行：

```ts
import type {
  ChatMessage,
  ContextUsage,
  ModelOption,
  PermissionRequest,
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
  PermissionRequest,
  TaskItem,
  TextBlock,
  ToolCallBlock,
  ImageBlock,
} from "../types/chat";
```

- [ ] **Step 3: `SessionStore` interface 新增 `tasks` 字段**

第 21-35 行的 `SessionStore` interface，在 `contextUsage` 字段后追加：

```ts
  /** 上下文窗口用量——每轮结束后由 sidecar 刷新；null 表示还没收到过 */
  contextUsage: ContextUsage | null;
  /** 当前任务清单——sidecar 每次变化后整体覆盖，不做增量合并 */
  tasks: TaskItem[];
}
```

（即把原本的收尾 `}` 挪到新字段后面。）

- [ ] **Step 4: `getStore` 初始化新增 `tasks: []`**

第 56-70 行的 `getStore` 函数里，`contextUsage: null,` 后面追加：

```ts
      contextUsage: null,
      tasks: [],
    };
```

- [ ] **Step 5: `handleChatEvent` 新增 `tasks_update` 分支**

在 `case "context_usage":` 分支（第 197-204 行）后面、`case "message_stop":` 前面插入：

```ts
    case "tasks_update": {
      store.tasks = e["tasks"] as TaskItem[];
      break;
    }
```

- [ ] **Step 6: 返回对象新增 `tasks` computed**

第 425-443 行的返回对象，在 `contextUsage` 那一行后面追加：

```ts
    contextUsage: computed(() => current.value?.contextUsage ?? null),
    tasks: computed(() => current.value?.tasks ?? []),
```

- [ ] **Step 7: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无报错输出（退出码 0）

- [ ] **Step 8: Commit**

```bash
git add src/types/chat.ts src/composables/useChatSession.ts
git commit -m "feat(chat): useChatSession 接入 tasks_update 事件"
```

---

### Task 5: TaskListPanel 组件 + 接入 ChatPanel/App，端到端验证

**Files:**
- Create: `src/components/TaskListPanel.vue`
- Modify: `src/components/ChatPanel.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `TaskItem`（Task 4，`src/types/chat.ts`）、`tasks: ComputedRef<TaskItem[]>`（Task 4，`useChatSession` 返回值）。

- [ ] **Step 1: 新建 `src/components/TaskListPanel.vue`**

```vue
<script setup lang="ts">
import type { TaskItem } from "@/types/chat";

const props = defineProps<{ tasks: TaskItem[] }>();

function statusIcon(status: TaskItem["status"]): string {
  if (status === "completed") return "✅";
  if (status === "in_progress") return "🔧";
  return "⬜";
}

function displayText(task: TaskItem): string {
  return task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
}
</script>

<template>
  <div class="task-list-panel">
    <div
      v-for="task in props.tasks"
      :key="task.id"
      class="task-item"
      :class="`task-item-${task.status}`"
    >
      <span class="task-icon">{{ statusIcon(task.status) }}</span>
      <span class="task-text">{{ displayText(task) }}</span>
    </div>
  </div>
</template>

<style scoped>
.task-list-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aide-border);
  background: var(--aide-bg-raised);
  font-size: 12px;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--aide-text-secondary);
}

.task-item-completed {
  color: var(--aide-text-muted);
  text-decoration: line-through;
}

.task-item-in_progress {
  color: var(--aide-text-primary);
  font-weight: 600;
}

.task-icon {
  flex-shrink: 0;
  font-size: 11px;
}

.task-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
```

- [ ] **Step 2: `ChatPanel.vue` 新增 import + prop**

第 4-12 行的 import 块：

```ts
import ChatMessage from "./ChatMessage.vue";
import type { ChatMessage as ChatMessageType, ContextUsage, ModelOption, TextBlock } from "@/types/chat";
```

改成：

```ts
import ChatMessage from "./ChatMessage.vue";
import TaskListPanel from "./TaskListPanel.vue";
import type { ChatMessage as ChatMessageType, ContextUsage, ModelOption, TaskItem, TextBlock } from "@/types/chat";
```

第 17-27 行的 `props` 定义：

```ts
const props = defineProps<{
  sessionId: string | null;
  sessionName?: string;
  workspacePath?: string;
  messages: ComputedRef<ChatMessageType[]> | ChatMessageType[];
  isBusy: { value: boolean } | boolean;
  models?: ModelOption[];
  currentModel?: string;
  totalCostUsd?: number;
  contextUsage?: ContextUsage | null;
}>();
```

改成（新增 `tasks` 字段）：

```ts
const props = defineProps<{
  sessionId: string | null;
  sessionName?: string;
  workspacePath?: string;
  messages: ComputedRef<ChatMessageType[]> | ChatMessageType[];
  isBusy: { value: boolean } | boolean;
  models?: ModelOption[];
  currentModel?: string;
  totalCostUsd?: number;
  contextUsage?: ContextUsage | null;
  tasks?: TaskItem[];
}>();
```

- [ ] **Step 3: `ChatPanel.vue` 模板里挂载面板**

第 283-296 行的模板：

```html
<template>
  <div class="chat-panel">
    <div class="chat-header">
      <AStatusDot :status="currentStatus" />
      <span class="chat-header-name">{{ sessionName || sessionId || '新对话' }}</span>
      <button
        v-if="isLive"
        class="chat-stop-btn"
        title="停止会话进程"
        @click="emit('stop')"
      >⏹ 停止</button>
    </div>

    <div ref="scrollEl" class="chat-messages" @scroll.passive="onScroll">
```

改成（在 `.chat-header` 和 `.chat-messages` 之间插入面板）：

```html
<template>
  <div class="chat-panel">
    <div class="chat-header">
      <AStatusDot :status="currentStatus" />
      <span class="chat-header-name">{{ sessionName || sessionId || '新对话' }}</span>
      <button
        v-if="isLive"
        class="chat-stop-btn"
        title="停止会话进程"
        @click="emit('stop')"
      >⏹ 停止</button>
    </div>

    <TaskListPanel v-if="props.tasks && props.tasks.length > 0" :tasks="props.tasks" />

    <div ref="scrollEl" class="chat-messages" @scroll.passive="onScroll">
```

- [ ] **Step 4: `App.vue` 解构 `tasks` 并传给 `ChatPanel`**

第 110 行：

```ts
const { pendingPermission, respondPermission, messages, isBusy, models, currentModel, totalCostUsd, contextUsage, sendMessage, interrupt, stopSession, onSessionCreated, setModel } = useChatSession(chatSessionIdRef);
```

改成：

```ts
const { pendingPermission, respondPermission, messages, isBusy, models, currentModel, totalCostUsd, contextUsage, tasks, sendMessage, interrupt, stopSession, onSessionCreated, setModel } = useChatSession(chatSessionIdRef);
```

第 515-525 行的 `<ChatPanel>` 标签：

```html
        <ChatPanel
          :session-id="activeSessionId || null"
          :session-name="activeSessionName"
          :workspace-path="workspacePath"
          :messages="messages"
          :is-busy="isBusy"
          :models="models"
          :current-model="currentModel"
          :total-cost-usd="totalCostUsd"
          :context-usage="contextUsage"
          class="h-full"
```

改成（新增 `:tasks`）：

```html
        <ChatPanel
          :session-id="activeSessionId || null"
          :session-name="activeSessionName"
          :workspace-path="workspacePath"
          :messages="messages"
          :is-busy="isBusy"
          :models="models"
          :current-model="currentModel"
          :total-cost-usd="totalCostUsd"
          :context-usage="contextUsage"
          :tasks="tasks"
          class="h-full"
```

- [ ] **Step 5: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无报错输出（退出码 0）

- [ ] **Step 6: 手动端到端验证**

Run: `./dev.ps1`（或项目现有的一键启动脚本，启动 Tauri 开发环境）

在打开的应用里：
1. 新建一个会话，发一条需要拆解成多步骤的指令，例如："帮我做三件独立的事：1) 输出当前时间 2) 输出 1+1 的结果 3) 输出一句问候语"。
2. 观察聊天头部下方是否出现任务清单面板，条目状态应从空心方块 → 🔧（进行中，显示 `activeForm` 文案）→ ✅（完成）依次变化。
3. 展开消息流，确认里面**没有**出现名叫 `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` 的工具卡片（其他工具如 `Bash`/`Read`/`Edit` 的卡片应该照常出现，不受影响）。
4. 全部任务完成后，面板保留展示完成态（不自动消失/折叠）。
5. 点击"新建会话"或切换到另一个已有会话，确认任务面板要么不显示（新会话），要么显示的是目标会话自己的任务状态，不会看到上一个会话的残留数据。

Expected: 以上 5 点全部符合预期；若任何一点不符，回到对应 Task 排查（面板不出现 → 查 Task 5 wiring；工具名泄露到消息流 → 查 Task 2 mapper 路由；状态没有实时更新 → 查 Task 1 TaskTracker 或 Task 4 store 覆盖逻辑）。

- [ ] **Step 7: Commit**

```bash
git add src/components/TaskListPanel.vue src/components/ChatPanel.vue src/App.vue
git commit -m "feat(chat): 新增任务进度展示面板并接入 ChatPanel"
```
