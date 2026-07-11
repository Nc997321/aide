import { describe, it, expect } from "vitest";
import {
  mapSdkMessage,
  describeResultError,
  buildRateLimitEvent,
  isAdoptableAssistantModel,
  filterSelectableModels,
} from "./mapper.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
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
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([]);
  });

  it("still emits tool_use_start for non-task tools", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("t1", "Bash", { command: "ls" }), (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([{ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" } }]);
  });

  it("emits tasks_update after TaskCreate's tool_result resolves, without a generic tool_result", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks, subagents, tools);
    mapSdkMessage(
      userToolResult("t1", "Task #1 created successfully: 写测试"),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    expect(events).toEqual([
      { type: "tasks_update", tasks: [{ id: "1", subject: "写测试", status: "pending", activeForm: undefined }] },
    ]);
  });

  it("emits tasks_update when a later TaskUpdate patches an existing task", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }), (e) => events.push(e), tasks, subagents, tools);
    mapSdkMessage(
      userToolResult("t1", "Task #1 created successfully: 写测试"),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    mapSdkMessage(
      assistantToolUse("t2", "TaskUpdate", { taskId: "1", status: "in_progress" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    expect(events).toEqual([
      { type: "tasks_update", tasks: [{ id: "1", subject: "写测试", status: "in_progress", activeForm: undefined }] },
    ]);
  });

  it("still emits generic tool_result for non-task tool results", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(userToolResult("t9", "ok"), (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([{ type: "tool_result", id: "t9", content: "ok", is_error: false }]);
  });
});

describe("mapSdkMessage streaming (includePartialMessages)", () => {
  function streamTextDelta(text: string, parentToolUseId: string | null = null) {
    return {
      type: "stream_event",
      parent_tool_use_id: parentToolUseId,
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    };
  }

  it("forwards stream_event text deltas as text_delta", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(streamTextDelta("你"), (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    mapSdkMessage(streamTextDelta("好"), (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    expect(events).toEqual([
      { type: "text_delta", delta: "你" },
      { type: "text_delta", delta: "好" },
    ]);
  });

  it("emits the final assistant text block as one text_delta (partial off)", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(assistantText("完整文本"), (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    expect(events).toEqual([
      { type: "text_delta", delta: "完整文本" },
    ]);
  });

  it("emits text_delta then tool_use_start for a mixed assistant message (partial off)", () => {
    const events: ChatEvent[] = [];
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "先说两句" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    };
    mapSdkMessage(msg, (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    expect(events).toEqual([
      { type: "text_delta", delta: "先说两句" },
      { type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("ignores non-text deltas (e.g. thinking_delta) and subagent stream events", () => {
    const events: ChatEvent[] = [];
    const thinking = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "内心戏" } },
    };
    mapSdkMessage(thinking, (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    mapSdkMessage(streamTextDelta("子代理文本", "a1"), (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    expect(events).toEqual([]);
  });
});

describe("mapSdkMessage local slash commands (/clear, /compact 等本地命令)", () => {
  // 根因：SDK 对 /clear /compact 这类本地命令是"绕过模型、绕过 result"的——
  // 只落一条 { type: "system", subtype: "local_command_output" }，SDK 自己的类型注释
  // 写明"Displayed as assistant-style text in the transcript"。mapSdkMessage 之前完全
  // 没有这个分支，五个 if 全部落空、函数直接 return undefined——用户发 /clear 后界面
  // 悄无声息：没有确认气泡，也没有 message_stop 把 running 状态收掉。
  it("renders local_command_output as assistant text + closes the turn", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      { type: "system", subtype: "local_command_output", content: "已清空上下文。", uuid: "u1", session_id: "s1" },
      (e) => events.push(e),
      new TaskTracker(),
      new SubagentTracker(),
      new ToolLifecycleTracker(),
    );
    expect(events).toEqual([
      { type: "text_delta", delta: "已清空上下文。" },
      { type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null },
    ]);
  });

  it("ignores an empty/whitespace-only local_command_output content (nothing to show)", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      { type: "system", subtype: "local_command_output", content: "   ", uuid: "u2", session_id: "s1" },
      (e) => events.push(e),
      new TaskTracker(),
      new SubagentTracker(),
      new ToolLifecycleTracker(),
    );
    expect(events).toEqual([
      { type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null },
    ]);
  });
});

describe("mapSdkMessage error results (未登录 / 额度上限 不再静默)", () => {
  const tasks = () => new TaskTracker();
  const subs = () => new SubagentTracker();
  const tools = () => new ToolLifecycleTracker();

  it("routes an error-subtype result to the error channel instead of message_stop", () => {
    const events: ChatEvent[] = [];
    // SDKResultError 形状没有 api_error_status，错误细节在 errors[] 里。
    mapSdkMessage(
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 401 Unauthorized"] },
      (e) => events.push(e),
      tasks(),
      subs(),
      tools(),
    );
    expect(events).toEqual([
      { type: "error", message: "API Error: 401 Unauthorized", fatal: false },
    ]);
  });

  it("treats a success-subtype result with is_error:true as an error too (429 quota)", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "rate limit exceeded" },
      (e) => events.push(e),
      tasks(),
      subs(),
      tools(),
    );
    expect(events).toEqual([
      { type: "error", message: "请求被限流或额度已用尽（HTTP 429） — rate limit exceeded", fatal: false },
    ]);
  });

  it("still emits message_stop for a clean successful result", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      { type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 },
      (e) => events.push(e),
      tasks(),
      subs(),
      tools(),
    );
    expect(events).toEqual([
      { type: "message_stop", stop_reason: "end_turn", total_cost_usd: 0.01, usage: null },
    ]);
  });

  it("describeResultError falls back to a subtype label when no detail is present", () => {
    expect(describeResultError({ subtype: "error_max_turns" })).toBe("已达到最大回合数上限");
  });

  // 回归：点插队/中断后弹出红色 "Error: [ede_diagnostic] result_type=user ..."——
  // 这是 CLI 打断转录时塞进 result.errors 的内部诊断面包屑，CLI 官方 UI 按
  // "[ede_diagnostic]" 前缀过滤，不是给用户看的错误。主动打断的 result（subtype
  // error_during_execution 且无任何用户可读错误细节）应压成 message_stop 正常收轮。
  it("主动打断的 result（只有 ede_diagnostic 面包屑）压成 message_stop，不弹错误气泡", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        total_cost_usd: 0.02,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
      },
      (e) => events.push(e),
      tasks(),
      subs(),
      tools(),
    );
    expect(events).toEqual([
      { type: "message_stop", stop_reason: "interrupted", total_cost_usd: 0.02, usage: null },
    ]);
  });

  it("真实错误混着 ede_diagnostic 面包屑时仍走错误通道，但把面包屑滤掉", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] turn aborted (abort) stop_reason=tool_use", "API Error: 500 Internal Server Error"],
      },
      (e) => events.push(e),
      tasks(),
      subs(),
      tools(),
    );
    expect(events).toEqual([
      { type: "error", message: "API Error: 500 Internal Server Error", fatal: false },
    ]);
  });

  it("带 api_error_status 的 error_during_execution 不算良性中断，照常报错", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      { type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 500, errors: [] },
      (e) => events.push(e),
      tasks(),
      subs(),
      tools(),
    );
    expect(events).toEqual([
      { type: "error", message: "接口返回错误（HTTP 500）", fatal: false },
    ]);
  });
});

describe("buildRateLimitEvent (订阅额度可见化，多窗口)", () => {
  it("folds all parallel windows with 0-100 utilization and ISO reset → ms", () => {
    const ev: any = buildRateLimitEvent({
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-07-04T20:00:00.000Z" },
        seven_day: { utilization: 76, resets_at: "2026-07-10T00:00:00.000Z" },
        seven_day_opus: { utilization: 91, resets_at: null },
        seven_day_sonnet: null,
        model_scoped: [{ display_name: "Fable", utilization: 12, resets_at: null }],
      },
    });
    expect(ev.type).toBe("rate_limit");
    expect(ev.subscription).toBe("max");
    expect(ev.windows).toEqual([
      { key: "five_hour", label: "5 小时", utilization: 42, resets_at: Date.parse("2026-07-04T20:00:00.000Z") },
      { key: "seven_day", label: "7 天", utilization: 76, resets_at: Date.parse("2026-07-10T00:00:00.000Z") },
      { key: "seven_day_opus", label: "7 天 Opus", utilization: 91, resets_at: null },
      { key: "model:Fable", label: "Fable", utilization: 12, resets_at: null },
    ]);
  });

  it("emits empty windows when rate limits are unavailable (API key / 3P)", () => {
    const ev: any = buildRateLimitEvent({ subscription_type: null, rate_limits_available: false, rate_limits: null });
    expect(ev).toEqual({ type: "rate_limit", subscription: null, windows: [] });
  });

  it("clamps utilization into 0-100 and skips windows with non-numeric utilization", () => {
    const ev: any = buildRateLimitEvent({
      subscription_type: "pro",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 130, resets_at: null },   // clamp → 100
        seven_day: { utilization: null, resets_at: null },  // skipped
      },
    });
    expect(ev.windows).toEqual([{ key: "five_hour", label: "5 小时", utilization: 100, resets_at: null }]);
  });
});

describe("mapSdkMessage routing for subagent tools", () => {
  it("emits subagent_start instead of tool_use_start for the Agent tool", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    expect(events).toEqual([
      { type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX" },
    ]);
  });

  it("recognizes the pre-rename Task tool name too", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Task", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    expect(events).toEqual([
      { type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX" },
    ]);
  });

  it("emits subagent_end instead of a generic tool_result when the tracked id resolves", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    mapSdkMessage(userToolResult("a1", "调研结论：……"), (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([
      { type: "subagent_end", id: "a1", result: "调研结论：……", is_error: false },
    ]);
  });

  it("emits subagent_start with prompt when the Agent tool input carries one", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", {
        subagent_type: "general-purpose",
        description: "实现 Task 1",
        prompt: "You are implementing Task 1: ...",
      }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    expect(events).toEqual([
      {
        type: "subagent_start",
        id: "a1",
        agentName: "general-purpose",
        description: "实现 Task 1",
        prompt: "You are implementing Task 1: ...",
      },
    ]);
  });

  it("emits subagent_tool_result for a subagent-internal tool_result, keyed by inner tool_use id", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    // 子代理内部调了 inner1:Read，随后 user 消息回填该工具的产出（带 parent_tool_use_id）。
    mapSdkMessage(assistantToolUse("inner1", "Read", { file_path: "x.ts" }, "a1"), (e) => events.push(e), tasks, subagents, tools);
    events.length = 0;
    mapSdkMessage(
      {
        type: "user",
        parent_tool_use_id: "a1",
        message: { content: [{ type: "tool_result", tool_use_id: "inner1", content: "文件内容……" }] },
      },
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    expect(events).toEqual([
      { type: "subagent_tool_result", id: "a1", toolUseId: "inner1", content: "文件内容……", is_error: false },
    ]);
  });

  it("drops subagent-internal messages for an id we never saw start (defensive, shouldn't happen in practice)", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantText("子代理内部的思考文本", "a1"), (e) => events.push(e), tasks, subagents, tools);
    mapSdkMessage(assistantToolUse("inner1", "Read", { file_path: "x.ts" }, "a1"), (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([]);
  });

  it("emits subagent_text_delta for a tracked subagent's pure text, then subagent_progress for its tool_use (partial off)", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    // 子代理内部一条纯文本消息：partial 关闭后没有逐字增量，整块一次性发出。
    mapSdkMessage(assistantText("我先看看仓库结构", "a1"), (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([
      { type: "subagent_text_delta", id: "a1", delta: "我先看看仓库结构" },
    ]);
    events.length = 0;
    // 子代理内部真正调用了工具：应转成 subagent_progress，而不是 tool_use_start。
    mapSdkMessage(assistantToolUse("inner1", "Read", { file_path: "x.ts" }, "a1"), (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([
      { type: "subagent_progress", id: "a1", toolUseId: "inner1", toolName: "Read", input: { file_path: "x.ts" } },
    ]);
  });

  it("attaches model on the first adoptable subagent-internal assistant message, only once", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    const step1 = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { model: "claude-sonnet-5-20260101", content: [{ type: "tool_use", id: "inner1", name: "Read", input: { file_path: "x.ts" } }] },
    };
    const step2 = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { model: "claude-sonnet-5-20260101", content: [{ type: "tool_use", id: "inner2", name: "Bash", input: { command: "ls" } }] },
    };
    mapSdkMessage(step1, (e) => events.push(e), tasks, subagents, tools);
    mapSdkMessage(step2, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([
      { type: "subagent_progress", id: "a1", toolUseId: "inner1", toolName: "Read", input: { file_path: "x.ts" }, model: "claude-sonnet-5-20260101" },
      { type: "subagent_progress", id: "a1", toolUseId: "inner2", toolName: "Bash", input: { command: "ls" } },
    ]);
  });

  // 回归：emitSubagentBlocks 以前对纯文本消息也无条件调用 claimModel()——即使这条
  // 消息走的是 toolUses.length === 0 的早退分支、model 根本用不上。子代理先说一句
  // 文本（很常见，如"我先看看…"）再调工具时，这次文本消息会把一次性的"报一次
  // model"名额悄悄吞掉，导致后面真正携带 tool_use 的消息永远拿不到 model 字段。
  it("子代理先发纯文本消息（带 model）不消耗一次性名额，随后的 tool_use 消息仍能拿到 model", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    const textStep = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { model: "claude-sonnet-5-20260101", content: [{ type: "text", text: "我先看看仓库结构" }] },
    };
    const toolStep = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: {
        model: "claude-sonnet-5-20260101",
        content: [{ type: "tool_use", id: "inner1", name: "Read", input: { file_path: "x.ts" } }],
      },
    };
    mapSdkMessage(textStep, (e) => events.push(e), tasks, subagents, tools);
    mapSdkMessage(toolStep, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([
      { type: "subagent_text_delta", id: "a1", delta: "我先看看仓库结构" },
      {
        type: "subagent_progress",
        id: "a1",
        toolUseId: "inner1",
        toolName: "Read",
        input: { file_path: "x.ts" },
        model: "claude-sonnet-5-20260101",
      },
    ]);
  });

  it("does not attach a placeholder/error-echo model to subagent progress", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    const placeholderStep = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { model: "<synthetic>", content: [{ type: "tool_use", id: "inner1", name: "Read", input: { file_path: "x.ts" } }] },
    };
    mapSdkMessage(placeholderStep, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([
      { type: "subagent_progress", id: "a1", toolUseId: "inner1", toolName: "Read", input: { file_path: "x.ts" } },
    ]);
  });

  it("forwards a tracked subagent's stream_event text_delta as subagent_text_delta", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "a1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "我先看" } },
    };
    mapSdkMessage(delta, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([{ type: "subagent_text_delta", id: "a1", delta: "我先看" }]);
  });

  it("forwards a tracked subagent's stream_event thinking_delta as subagent_thinking_delta", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "a1",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "内心戏" } },
    };
    mapSdkMessage(delta, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([{ type: "subagent_thinking_delta", id: "a1", delta: "内心戏" }]);
  });

  it("ignores a subagent stream_event for an id we never saw start (defensive)", () => {
    const events: ChatEvent[] = [];
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "ghost",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "不该出现" } },
    };
    mapSdkMessage(delta, (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    expect(events).toEqual([]);
  });

  it("still ignores pure thinking blocks in a full subagent assistant message (already streamed as deltas)", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    const msg = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { content: [{ type: "thinking", thinking: "内心戏" }] },
    };
    mapSdkMessage(msg, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([]);
  });

  it("async launch-ack tool_result 发 subagent_async_launched 而非 subagent_end，并注册 agentId+outputFile", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    // async launch-ack：Agent 工具的 tool_result 立即返回这条文本
    const launchAck = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a1", content: "Async agent launched successfully. agentId: ab99381a4a2eb9ccd (internal ID …) The agent is working in the background. output_file: C:\\Users\\x\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output\nDo NOT Read this file via the shell tool …" }],
      },
    };
    mapSdkMessage(launchAck, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([
      { type: "subagent_async_launched", id: "a1", agentId: "ab99381a4a2eb9ccd", outputFile: "C:\\Users\\x\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output" },
    ]);
    expect(subagents.isActive("a1")).toBe(true); // 没被 launch-ack 关掉
    expect(subagents.getAsyncOutputFile("a1")).toBe("C:\\Users\\x\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output");
  });

  it("sync 子代理 tool_result（无 launch-ack 签名）仍走 subagent_end，不被误判 async", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    const syncResult = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "调研结论：用了 Vue3+Tauri。" }] },
    };
    mapSdkMessage(syncResult, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "调研结论：用了 Vue3+Tauri。", is_error: false }]);
    expect(subagents.isActive("a1")).toBe(false);
  });

  it("async launch-ack 的 output_file 路径含空格时仍能正确提取（Windows profile 名含空格的情形）", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(
      assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
      (e) => events.push(e),
      tasks,
      subagents,
      tools,
    );
    events.length = 0;
    // async launch-ack with a space-containing path (Windows profile "John Doe")
    const launchAckWithSpaces = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a1", content: "Async agent launched successfully. agentId: ab99381a4a2eb9ccd (internal ID …) The agent is working in the background. output_file: C:\\Users\\John Doe\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output\nDo NOT Read this file via the shell tool …" }],
      },
    };
    mapSdkMessage(launchAckWithSpaces, (e) => events.push(e), tasks, subagents, tools);
    expect(events).toEqual([
      { type: "subagent_async_launched", id: "a1", agentId: "ab99381a4a2eb9ccd", outputFile: "C:\\Users\\John Doe\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output" },
    ]);
    expect(subagents.isActive("a1")).toBe(true);
    expect(subagents.getAsyncOutputFile("a1")).toBe("C:\\Users\\John Doe\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output");
  });
});

describe("mapSdkMessage system/init → slash_commands_available", () => {
  function systemInit(sessionId: string, slashCommands?: unknown) {
    return {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      ...(slashCommands !== undefined ? { slash_commands: slashCommands } : {}),
    };
  }

  it("slash_commands 是数组时，session_init 之外多发一条 slash_commands_available", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      systemInit("s1", ["clear", "compact", "code-review"]),
      (e) => events.push(e),
      new TaskTracker(),
      new SubagentTracker(),
      new ToolLifecycleTracker(),
    );
    expect(events).toEqual([
      { type: "session_init", session_id: "s1" },
      { type: "slash_commands_available", commands: ["clear", "compact", "code-review"] },
    ]);
  });

  it("slash_commands 是空数组时，仍然发出（不是缺省不发）", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(systemInit("s1", []), (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    expect(events).toEqual([
      { type: "session_init", session_id: "s1" },
      { type: "slash_commands_available", commands: [] },
    ]);
  });

  it("slash_commands 字段缺失时（旧版 CLI），只发 session_init", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(systemInit("s1"), (e) => events.push(e), new TaskTracker(), new SubagentTracker(), new ToolLifecycleTracker());
    expect(events).toEqual([{ type: "session_init", session_id: "s1" }]);
  });
});

// 回归：额度耗尽期间 CLI 会本地生成占位 assistant 消息（如"你已达到额度上限"），
// 其 message.model 可能是内部占位符（尖括号包裹，如 "<synthetic>"），不是真实
// 可选模型；一条带 error 的 assistant 消息也只是失败回声，不代表"现在真的在用
// 这个模型"。这两类消息以前被 index.ts 无条件采信为"当前生效模型"并写回下一轮
// query 的显式 model 参数，导致额度恢复后所有请求都显式请求一个不存在的模型、
// 永久 404（且错误回声的 model 字段还是同一个占位符，越修越锁死，直到整个会话
// 进程重启）。
describe("isAdoptableAssistantModel（过滤占位符模型 / 错误回声，防止污染 currentModel）", () => {
  it("正常 assistant 消息的具体 wire model id 可采信", () => {
    expect(isAdoptableAssistantModel({ message: { model: "claude-sonnet-5-20260101" } })).toBe(true);
  });

  it("尖括号包裹的内部占位符（如额度耗尽时的 <synthetic>）不可采信", () => {
    expect(isAdoptableAssistantModel({ message: { model: "<synthetic>" } })).toBe(false);
  });

  it("带 error 字段的 assistant 消息（如 model_not_found 回声）不可采信，即使 model 字段本身看起来正常", () => {
    expect(
      isAdoptableAssistantModel({ error: "model_not_found", message: { model: "claude-sonnet-5-20260101" } }),
    ).toBe(false);
  });

  it("model 字段缺失或为空串时不可采信", () => {
    expect(isAdoptableAssistantModel({ message: {} })).toBe(false);
    expect(isAdoptableAssistantModel({ message: { model: "" } })).toBe(false);
  });
});

describe("filterSelectableModels（模型下拉框过滤内部占位符）", () => {
  it("保留正常模型，剔除 value 或 displayName 是尖括号占位符的条目", () => {
    const models = [
      { value: "sonnet", displayName: "Sonnet" },
      { value: "<synthetic>", displayName: "<synthetic>" },
      { value: "opus", displayName: "Opus" },
    ];
    expect(filterSelectableModels(models)).toEqual([
      { value: "sonnet", displayName: "Sonnet" },
      { value: "opus", displayName: "Opus" },
    ]);
  });
});
