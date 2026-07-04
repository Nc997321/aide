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
    mapSdkMessage(streamTextDelta("你"), (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    mapSdkMessage(streamTextDelta("好"), (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    expect(events).toEqual([
      { type: "text_delta", delta: "你" },
      { type: "text_delta", delta: "好" },
    ]);
  });

  it("skips the final assistant text block (already streamed as deltas)", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(assistantText("完整文本"), (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    expect(events).toEqual([]);
  });

  it("still emits tool_use_start for tool_use blocks in a mixed assistant message", () => {
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
    mapSdkMessage(msg, (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    expect(events).toEqual([{ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" } }]);
  });

  it("ignores non-text deltas (e.g. thinking_delta) and subagent stream events", () => {
    const events: ChatEvent[] = [];
    const thinking = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "内心戏" } },
    };
    mapSdkMessage(thinking, (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    mapSdkMessage(streamTextDelta("子代理文本", "a1"), (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    expect(events).toEqual([]);
  });
});

describe("mapSdkMessage error results (未登录 / 额度上限 不再静默)", () => {
  const tasks = () => new TaskTracker();
  const subs = () => new SubagentTracker();

  it("routes an error-subtype result to the error channel instead of message_stop", () => {
    const events: ChatEvent[] = [];
    // SDKResultError 形状没有 api_error_status，错误细节在 errors[] 里。
    mapSdkMessage(
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 401 Unauthorized"] },
      (e) => events.push(e),
      tasks(),
      subs(),
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
    );
    expect(events).toEqual([
      { type: "message_stop", stop_reason: "end_turn", total_cost_usd: 0.01, usage: null },
    ]);
  });

  it("describeResultError falls back to a subtype label when no detail is present", () => {
    expect(describeResultError({ subtype: "error_max_turns" })).toBe("已达到最大回合数上限");
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
    );
    expect(events).toEqual([
      { type: "session_init", session_id: "s1" },
      { type: "slash_commands_available", commands: ["clear", "compact", "code-review"] },
    ]);
  });

  it("slash_commands 是空数组时，仍然发出（不是缺省不发）", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(systemInit("s1", []), (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    expect(events).toEqual([
      { type: "session_init", session_id: "s1" },
      { type: "slash_commands_available", commands: [] },
    ]);
  });

  it("slash_commands 字段缺失时（旧版 CLI），只发 session_init", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(systemInit("s1"), (e) => events.push(e), new TaskTracker(), new SubagentTracker());
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
