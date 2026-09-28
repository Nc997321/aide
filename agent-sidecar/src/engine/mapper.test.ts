import { describe, it, expect, vi } from "vitest";
import {
  mapSdkMessage,
  describeResultError,
  buildRateLimitEvent,
  isAdoptableAssistantModel,
  filterSelectableModels,
  isErrorResult,
} from "./mapper.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { ToolLifecycleTracker } from "./toolLifecycle.js";
import * as tailMod from "./subagentOutputTail.js";
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

/** async（后台）子代理的 launch-ack：Agent 工具后台派发时 tool_result 立即返回的回执
 *  （不是结果）。CLI ≥2.1.x 的 Agent 默认后台派发（工具面原文：Agents run in the
 *  background by default）。 */
function agentLaunchAck(toolUseId: string, agentId = "ab99381a4a2eb9ccd") {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `Async agent launched successfully. agentId: ${agentId} (internal ID - do not mention to user.) The agent is working in the background. output_file: C:\\x\\tasks\\${agentId}.output\nDo NOT Read or tail this file via the shell tool`,
      }],
    },
  };
}

/** CLI 的结构化任务帧（system/task_notification）：后台 shell 任务与 async 子代理共用
 *  的终态通道。2026-09-28 SDK 0.3.252 线上实探：async 子代理完成只到这一条（带
 *  tool_use_id=Agent tool_use id），<task-notification> XML 用户消息不进 SDK 流。 */
function taskNotificationFrame(fields: Record<string, unknown>) {
  return { type: "system", subtype: "task_notification", ...fields };
}

describe("mapSdkMessage routing for Task tools", () => {
  it("does not emit tool_use_start for TaskCreate", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([]);
  });

  it("still emits tool_use_start for non-task tools", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("t1", "Bash", { command: "ls" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([{ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" } }]);
  });

  it("主线程 assistant 消息：wire model 只盖在首个块事件上，label 走注入的解析器", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    const msg = {
      type: "assistant",
      message: {
        model: "claude-sonnet-5-20260101",
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
      },
    };
    mapSdkMessage(msg,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools, resolveModelLabel: (w) => `alias-of-${w}` });
    expect(events).toEqual([
      { type: "text_delta", delta: "第一段", model: "claude-sonnet-5-20260101", modelLabel: "alias-of-claude-sonnet-5-20260101" },
      { type: "text_delta", delta: "第二段" },
    ]);
  });

  it("首块是工具调用时 model 盖在 tool_use_start 上；不传解析器则 label 即 wire 原文", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    const msg = {
      type: "assistant",
      message: { model: "kimi-for-coding", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    };
    mapSdkMessage(msg,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "tool_use_start", id: "t1", name: "Bash", input: {}, model: "kimi-for-coding", modelLabel: "kimi-for-coding" },
    ]);
  });

  it("占位符/错误回声的 model 不盖章（不会把 <synthetic> 显示到消息上）", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "x" }] } },
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    mapSdkMessage({ type: "assistant", error: "model_not_found", message: { model: "claude-x", content: [{ type: "text", text: "y" }] } },
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "text_delta", delta: "x" },
      { type: "text_delta", delta: "y" },
    ]);
  });


  it("emits tasks_update after TaskCreate's tool_result resolves, without a generic tool_result", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    mapSdkMessage(userToolResult("t1", "Task #1 created successfully: 写测试"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "tasks_update", tasks: [{ id: "1", subject: "写测试", status: "pending", activeForm: undefined }] },
    ]);
  });

  it("emits tasks_update when a later TaskUpdate patches an existing task", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("t1", "TaskCreate", { subject: "写测试" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    mapSdkMessage(userToolResult("t1", "Task #1 created successfully: 写测试"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    mapSdkMessage(assistantToolUse("t2", "TaskUpdate", { taskId: "1", status: "in_progress" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "tasks_update", tasks: [{ id: "1", subject: "写测试", status: "in_progress", activeForm: undefined }] },
    ]);
  });

  it("still emits generic tool_result for non-task tool results", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(userToolResult("t9", "ok"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
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

  function streamThinkingDelta(text: string, parentToolUseId: string | null = null) {
    return {
      type: "stream_event",
      parent_tool_use_id: parentToolUseId,
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: text } },
    };
  }
  function assistantThinking(thinking: string) {
    return { type: "assistant", message: { content: [{ type: "thinking", thinking }] } };
  }
  /** 用 partialMode / showThinking 调 mapSdkMessage，返回 emit 的事件列表。subagents/tools 可传入共享。 */
  function mapPartial(msg: any, partialMode: boolean, subagents = new SubagentTracker(), tools = new ToolLifecycleTracker(), showThinking = true): ChatEvent[] {
    const events: ChatEvent[] = [];
    mapSdkMessage(msg,
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: subagents, tools: tools, partialMode: partialMode, showThinking: showThinking });
    return events;
  }

  // partial=off（默认 / btw / title）：SDK 不发 stream_event；即使到达也忽略。
  it("partial=off: stream_event 分支不转发任何 delta", () => {
    const events: ChatEvent[] = [];
    events.push(...mapPartial(streamTextDelta("你"), false));
    events.push(...mapPartial(streamThinkingDelta("想"), false));
    expect(events).toEqual([]);
  });

  // partial=on（主会话）：thinking_delta 逐字流式、text_delta 丢弃（text 走整块）。
  it("partial=on: forwards stream_event thinking_delta as thinking_delta", () => {
    const events: ChatEvent[] = [];
    events.push(...mapPartial(streamThinkingDelta("我"), true));
    events.push(...mapPartial(streamThinkingDelta("在想"), true));
    expect(events).toEqual([
      { type: "thinking_delta", delta: "我" },
      { type: "thinking_delta", delta: "在想" },
    ]);
  });

  it("partial=on: stream_event text_delta 逐字转发（2026-09-13 解禁正文流式）", () => {
    const events: ChatEvent[] = [];
    events.push(...mapPartial(streamTextDelta("你"), true));
    events.push(...mapPartial(streamTextDelta("好"), true));
    expect(events).toEqual([
      { type: "text_delta", delta: "你" },
      { type: "text_delta", delta: "好" },
    ]);
  });

  it("partial=on: skips thinking block in assistant message (已被 stream_event 逐字发过, 去重)", () => {
    expect(mapPartial(assistantThinking("整块思考"), true)).toEqual([]);
  });

  it("partial=on: assistant text block 不再重发正文，只发空增量补模型徽标", () => {
    // 正文已由 stream_event 逐字发过；整块路径留一个空 delta 让 withModel 把
    // wire model 带出去（前端对空 delta 只盖戳不入块）。
    expect(mapPartial(assistantText("完整文本"), true)).toEqual([{ type: "text_delta", delta: "" }]);
  });

  it("partial=on: assistant text+thinking mixed, thinking 跳过、text 只补戳", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "思考" }, { type: "text", text: "正文" }] },
    };
    expect(mapPartial(msg, true)).toEqual([{ type: "text_delta", delta: "" }]);
  });

  it("partial=on: 空 thinking（display=omitted）两边都不发", () => {
    expect(mapPartial({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "" } } }, true)).toEqual([]);
    expect(mapPartial({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }, true)).toEqual([]);
  });

  // 思考开关关闭（showThinking=false）：ollama 兼容端点不认 thinking 参数、模型总会
  // 出思考块（2026-08-21 mock 端点实锤：disabled 时请求体无 thinking 字段），API 层
  // 关不掉，只能在展示层剥——thinking_delta 流 / assistant 整块 / 子代理块全剥，text 照发。
  it("showThinking=false: partial=on 剥 thinking_delta 流，text 只补戳", () => {
    expect(mapPartial(streamThinkingDelta("我在想"), true, undefined, undefined, false)).toEqual([]);
    expect(mapPartial(assistantText("完整文本"), true, undefined, undefined, false)).toEqual([{ type: "text_delta", delta: "" }]);
  });

  it("showThinking=false: partial=off 剥 assistant thinking 整块（ollama 主路径），text 照发", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "思考" }, { type: "text", text: "正文" }] },
    };
    expect(mapPartial(msg, false, undefined, undefined, false)).toEqual([{ type: "text_delta", delta: "正文" }]);
  });

  it("showThinking=false: 剥子代理 thinking 整块（subagent_thinking_delta 不发）", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const step = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { model: "x", content: [{ type: "thinking", thinking: "子代理思考" }, { type: "text", text: "子代理文本" }] },
    };
    mapSdkMessage(step,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools, partialMode: true, showThinking: false });
    expect(events).toEqual([{ type: "subagent_text_delta", id: "a1", delta: "子代理文本" }]);
  });

  it("partial=on: 子代理 stream_event 丢弃（走整块，不连带逐字流式）", () => {
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    // 先注册子代理 a1（Agent tool_use → active）
    mapPartial(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研" }), true, subagents, tools);
    expect(subagents.isActive("a1")).toBe(true);
    const events: ChatEvent[] = [];
    events.push(...mapPartial(streamTextDelta("子代理文本", "a1"), true, subagents, tools));
    events.push(...mapPartial(streamThinkingDelta("子代理思考", "a1"), true, subagents, tools));
    expect(events).toEqual([]);
  });

  it("emits the final assistant text block as one text_delta (partial off)", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(assistantText("完整文本"),
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
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
    mapSdkMessage(msg,
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
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
    mapSdkMessage(thinking,
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
    mapSdkMessage(streamTextDelta("子代理文本", "a1"),
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
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
    mapSdkMessage({ type: "system", subtype: "local_command_output", content: "已清空上下文。", uuid: "u1", session_id: "s1" },
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
    expect(events).toEqual([
      { type: "text_delta", delta: "已清空上下文。" },
      { type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null },
    ]);
  });

  it("ignores an empty/whitespace-only local_command_output content (nothing to show)", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({ type: "system", subtype: "local_command_output", content: "   ", uuid: "u2", session_id: "s1" },
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
    expect(events).toEqual([
      { type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null },
    ]);
  });
});

describe("mapSdkMessage context compaction lifecycle", () => {
  const tasks = () => new TaskTracker();
  const subs = () => new SubagentTracker();
  const tools = () => new ToolLifecycleTracker();

  it("maps the SDK compacting status to the provider-neutral lifecycle event", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({ type: "system", subtype: "status", status: "compacting" },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });

    expect(events).toEqual([{ type: "context_compaction", stage: "compacting" }]);
  });

  it("maps compact completion without inventing a percentage", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({ type: "system", subtype: "status", compact_result: "success" },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });

    expect(events).toEqual([{ type: "context_compaction", stage: "completed" }]);
  });

  it("maps a compact failure and preserves its provider-supplied explanation", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({ type: "system", subtype: "status", compact_result: "failed", compact_error: "压缩服务暂时不可用" },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });

    expect(events).toEqual([
      { type: "context_compaction", stage: "failed", error: "压缩服务暂时不可用" },
    ]);
  });

  it("prefers a compact terminal result over a lingering compacting status", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({
        type: "system",
        subtype: "status",
        status: "compacting",
        compact_result: "failed",
        compact_error: "压缩被中止",
      },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });

    expect(events).toEqual([
      { type: "context_compaction", stage: "failed", error: "压缩被中止" },
    ]);
  });

  it("ignores unrelated SDK statuses", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({ type: "system", subtype: "status", status: "idle" },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });

    expect(events).toEqual([]);
  });
});

describe("mapSdkMessage error results (未登录 / 额度上限 不再静默)", () => {
  const tasks = () => new TaskTracker();
  const subs = () => new SubagentTracker();
  const tools = () => new ToolLifecycleTracker();

  it("routes an error-subtype result to the error channel instead of message_stop", () => {
    const events: ChatEvent[] = [];
    // SDKResultError 形状没有 api_error_status，错误细节在 errors[] 里。
    mapSdkMessage({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 401 Unauthorized"] },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });
    expect(events).toEqual([
      { type: "error", message: "API Error: 401 Unauthorized", fatal: false },
    ]);
  });

  it("treats a success-subtype result with is_error:true as an error too (429 quota)", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "rate limit exceeded" },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });
    expect(events).toEqual([
      { type: "error", message: "请求被限流或额度已用尽（HTTP 429） — rate limit exceeded", fatal: false },
    ]);
  });

  it("still emits message_stop for a clean successful result", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01 },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });
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
    mapSdkMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        total_cost_usd: 0.02,
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
      },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });
    expect(events).toEqual([
      { type: "message_stop", stop_reason: "interrupted", total_cost_usd: 0.02, usage: null },
    ]);
  });

  it("真实错误混着 ede_diagnostic 面包屑时仍走错误通道，但把面包屑滤掉", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] turn aborted (abort) stop_reason=tool_use", "API Error: 500 Internal Server Error"],
      },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });
    expect(events).toEqual([
      { type: "error", message: "API Error: 500 Internal Server Error", fatal: false },
    ]);
  });

  it("带 api_error_status 的 error_during_execution 不算良性中断，照常报错", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 500, errors: [] },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subs(), tools: tools() });
    expect(events).toEqual([
      { type: "error", message: "接口返回错误（HTTP 500）", fatal: false },
    ]);
  });
});

describe("mapSdkMessage usage 归因（subagentTurn / byModel）", () => {
  const tasks = () => new TaskTracker();
  const tools = () => new ToolLifecycleTracker();

  function successResult(modelUsage: Record<string, any>, cost = 0.5, numTurns = 1) {
    return { type: "result", subtype: "success", is_error: false, total_cost_usd: cost, modelUsage, num_turns: numTurns };
  }

  it("本轮派发了子代理时，message_stop.usage 带 subagentTurn=true + subagentCount", () => {
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    // 一轮内派发 2 个子代理（assistant Agent tool_use → mapper 调 subagents.handleToolUse 累加计数）
    mapSdkMessage(assistantToolUse("sa1", "Agent", { description: "a" }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    mapSdkMessage(assistantToolUse("sa2", "Agent", { description: "b" }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    mapSdkMessage(successResult({ "claude-sonnet-5": { inputTokens: 1000, outputTokens: 100, costUSD: 0.01 } }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    const stop = events.find((e) => e.type === "message_stop") as any;
    expect(stop.usage).toMatchObject({ inputTokens: 1000, subagentTurn: true, subagentCount: 2 });
    // 单模型不带 byModel
    expect(stop.usage.byModel).toBeUndefined();
  });

  it("本轮无子代理时，usage 不带 subagentTurn（前端走 solo 分流）", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(successResult({ "claude-sonnet-5": { inputTokens: 200, outputTokens: 20, costUSD: 0.002 } }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: new SubagentTracker(), tools: tools() });
    const stop = events.find((e) => e.type === "message_stop") as any;
    expect(stop.usage.subagentTurn).toBeUndefined();
    expect(stop.usage.subagentCount).toBeUndefined();
  });

  it("多模型时保留 byModel 分桶，同时给出汇总总数", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(successResult({
        "claude-sonnet-5": { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, costUSD: 0.01 },
        "claude-haiku-4": { inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 },
      }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: new SubagentTracker(), tools: tools() });
    const stop = events.find((e) => e.type === "message_stop") as any;
    expect(stop.usage.inputTokens).toBe(1300);
    expect(stop.usage.byModel).toMatchObject({
      "claude-sonnet-5": { inputTokens: 1000 },
      "claude-haiku-4": { inputTokens: 300 },
    });
  });

  it("apiCallCount 透传 result.num_turns（前端据此把 ↓ 累计输入拆成 ×N 分解）", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(// 4.2m 输入 / 20 次调用 = 平均每次 210k ≈ ctx，正是反直觉场景的分解
      successResult({ "claude-sonnet-5": { inputTokens: 4200000, outputTokens: 30000, costUSD: 0.03 } }, 0.03, 20),
  (e) => events.push(e),
  { tasks: tasks(), subagents: new SubagentTracker(), tools: tools() });
    const stop = events.find((e) => e.type === "message_stop") as any;
    expect(stop.usage.apiCallCount).toBe(20);
    // 默认 num_turns=1（无工具单调用轮）也透传，前端按 >1 才展示分解
    const events2: ChatEvent[] = [];
    mapSdkMessage(successResult({ "claude-sonnet-5": { inputTokens: 214352, outputTokens: 500, costUSD: 0.001 } }),
  (e) => events2.push(e),
  { tasks: tasks(), subagents: new SubagentTracker(), tools: tools() });
    const stop2 = events2.find((e) => e.type === "message_stop") as any;
    expect(stop2.usage.apiCallCount).toBe(1);
  });

  it("error/abort result 也消费掉本轮子代理计数，不泄漏到下一轮", () => {
    const subagents = new SubagentTracker();
    const events: ChatEvent[] = [];
    mapSdkMessage(assistantToolUse("sa1", "Agent", { description: "a" }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    // 本轮以 abort result 收尾（usage:null），计数应被消费
    mapSdkMessage({ type: "result", subtype: "error_during_execution", is_error: true, total_cost_usd: 0, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"] },
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    // 下一轮无子代理，usage 不应带 subagentTurn
    events.length = 0;
    mapSdkMessage(successResult({ "claude-sonnet-5": { inputTokens: 10, outputTokens: 1, costUSD: 0 } }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    const stop = events.find((e) => e.type === "message_stop") as any;
    expect(stop.usage.subagentTurn).toBeUndefined();
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
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX" },
    ]);
  });

  it("recognizes the pre-rename Task tool name too", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Task", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX" },
    ]);
  });

  it("emits subagent_end instead of a generic tool_result when the tracked id resolves", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    mapSdkMessage(userToolResult("a1", "调研结论：……"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_end", id: "a1", result: "调研结论：……", is_error: false },
    ]);
  });

  it("emits subagent_start with prompt when the Agent tool input carries one", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", {
        subagent_type: "general-purpose",
        description: "实现 Task 1",
        prompt: "You are implementing Task 1: ...",
      }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
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
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    // 子代理内部调了 inner1:Read，随后 user 消息回填该工具的产出（带 parent_tool_use_id）。
    mapSdkMessage(assistantToolUse("inner1", "Read", { file_path: "x.ts" }, "a1"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    mapSdkMessage({
        type: "user",
        parent_tool_use_id: "a1",
        message: { content: [{ type: "tool_result", tool_use_id: "inner1", content: "文件内容……" }] },
      },
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_tool_result", id: "a1", toolUseId: "inner1", content: "文件内容……", is_error: false },
    ]);
  });

  it("drops subagent-internal messages for an id we never saw start (defensive, shouldn't happen in practice)", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantText("子代理内部的思考文本", "a1"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    mapSdkMessage(assistantToolUse("inner1", "Read", { file_path: "x.ts" }, "a1"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([]);
  });

  it("emits subagent_text_delta for a tracked subagent's pure text, then subagent_progress for its tool_use (partial off)", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    // 子代理内部一条纯文本消息：partial 关闭后没有逐字增量，整块一次性发出。
    mapSdkMessage(assistantText("我先看看仓库结构", "a1"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_text_delta", id: "a1", delta: "我先看看仓库结构" },
    ]);
    events.length = 0;
    // 子代理内部真正调用了工具：应转成 subagent_progress，而不是 tool_use_start。
    mapSdkMessage(assistantToolUse("inner1", "Read", { file_path: "x.ts" }, "a1"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_progress", id: "a1", toolUseId: "inner1", toolName: "Read", input: { file_path: "x.ts" } },
    ]);
  });

  it("子代理内部的 Edit：input 原样透传（file_path + old_string + new_string 都在）", () => {
    // 桌面端变更归集器吃这个事件生成 diff 片段（src/composables/useChangeAttribution.ts
    // 的 TOOL_NAME_FIELD），input 必须完整——截断或改名都会让子代理改的文件从
    // 变更列表里消失。此例即该契约的守护测试。
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "改代码" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const input = { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" };
    mapSdkMessage(assistantToolUse("inner1", "Edit", input, "a1"),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_progress", id: "a1", toolUseId: "inner1", toolName: "Edit", input },
    ]);
  });

  it("attaches model on the first adoptable subagent-internal assistant message, only once", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
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
    mapSdkMessage(step1,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    mapSdkMessage(step2,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
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
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
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
    mapSdkMessage(textStep,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    mapSdkMessage(toolStep,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
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
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const placeholderStep = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { model: "<synthetic>", content: [{ type: "tool_use", id: "inner1", name: "Read", input: { file_path: "x.ts" } }] },
    };
    mapSdkMessage(placeholderStep,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_progress", id: "a1", toolUseId: "inner1", toolName: "Read", input: { file_path: "x.ts" } },
    ]);
  });

  it("forwards a tracked subagent's stream_event text_delta as subagent_text_delta", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "a1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "我先看" } },
    };
    mapSdkMessage(delta,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([{ type: "subagent_text_delta", id: "a1", delta: "我先看" }]);
  });

  it("forwards a tracked subagent's stream_event thinking_delta as subagent_thinking_delta", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "a1",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "内心戏" } },
    };
    mapSdkMessage(delta,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([{ type: "subagent_thinking_delta", id: "a1", delta: "内心戏" }]);
  });

  it("ignores a subagent stream_event for an id we never saw start (defensive)", () => {
    const events: ChatEvent[] = [];
    const delta = {
      type: "stream_event",
      parent_tool_use_id: "ghost",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "不该出现" } },
    };
    mapSdkMessage(delta,
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
    expect(events).toEqual([]);
  });

  it("emits subagent_thinking_delta for thinking blocks in a full subagent assistant message (includePartialMessages off)", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const msg = {
      type: "assistant",
      parent_tool_use_id: "a1",
      message: { content: [{ type: "thinking", thinking: "内心戏" }] },
    };
    mapSdkMessage(msg,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    // 有流式增量时 thinking 不会以完整块到达（已被 stream_event 的
    // content_block_delta 逐字转发）；但 includePartialMessages 关闭后
    // thinking 完整块必须在此补发，否则子代理思考过程永久丢失。
    expect(events).toEqual([{ type: "subagent_thinking_delta", id: "a1", delta: "内心戏" }]);
  });

  it("async launch-ack tool_result 发 subagent_async_launched 而非 subagent_end，并注册 agentId+outputFile", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    // async launch-ack：Agent 工具的 tool_result 立即返回这条文本
    const launchAck = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a1", content: "Async agent launched successfully. agentId: ab99381a4a2eb9ccd (internal ID …) The agent is working in the background. output_file: C:\\Users\\x\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output\nDo NOT Read this file via the shell tool …" }],
      },
    };
    mapSdkMessage(launchAck,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
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
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const syncResult = {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "调研结论：用了 Vue3+Tauri。" }] },
    };
    mapSdkMessage(syncResult,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "调研结论：用了 Vue3+Tauri。", is_error: false }]);
    expect(subagents.isActive("a1")).toBe(false);
  });

  it("async launch-ack 的 output_file 路径含空格时仍能正确提取（Windows profile 名含空格的情形）", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    // async launch-ack with a space-containing path (Windows profile "John Doe")
    const launchAckWithSpaces = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a1", content: "Async agent launched successfully. agentId: ab99381a4a2eb9ccd (internal ID …) The agent is working in the background. output_file: C:\\Users\\John Doe\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output\nDo NOT Read this file via the shell tool …" }],
      },
    };
    mapSdkMessage(launchAckWithSpaces,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([
      { type: "subagent_async_launched", id: "a1", agentId: "ab99381a4a2eb9ccd", outputFile: "C:\\Users\\John Doe\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output" },
    ]);
    expect(subagents.isActive("a1")).toBe(true);
    expect(subagents.getAsyncOutputFile("a1")).toBe("C:\\Users\\John Doe\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\ab99381a4a2eb9ccd.output");
  });

  it("task-notification（user 字符串 content）发 subagent_end，结果取 <result>，停 tail", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    // 先把 a1 起成 async 子代理
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "调研 XXX" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const spy = vi.spyOn(tailMod, "stopOutputTail");
    // task-notification：user 消息，content 是 XML 字符串
    const note = {
      type: "user",
      message: { role: "user", content: "<task-notification>\n<task-id>ab99</task-id>\n<tool-use-id>a1</tool-use-id>\n<output-file>C:\\x\\ab99.output</output-file>\n<status>completed</status>\n<summary>Agent \"…\" finished</summary>\n<result>调研结论：用了 Vue3+Tauri。</result>\n<usage><subagent_tokens>100</subagent_tokens></usage>\n</task-notification>" },
      origin: { kind: "task-notification" },
    };
    mapSdkMessage(note,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "调研结论：用了 Vue3+Tauri。", is_error: false }]);
    expect(subagents.isActive("a1")).toBe(false);
    expect(spy).toHaveBeenCalledWith("a1");
    spy.mockRestore();
  });

  it("task-notification status 非 completed → is_error:true", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "general-purpose", description: "x" }),
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    events.length = 0;
    const note = {
      type: "user",
      message: { role: "user", content: "<task-notification>\n<tool-use-id>a1</tool-use-id>\n<status>failed</status>\n<result>model 不存在</result>\n</task-notification>" },
    };
    mapSdkMessage(note,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
    expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "model 不存在", is_error: true }]);
  });

  it("structured task_notification 收尾 async 子代理（CLI 默认后台派发的唯一终态通道）", () => {
    // 事故：Agent 默认后台派发后，tool_result 只是 launch-ack，真终态走这条 structured
    // 帧；它被后台任务分支无条件 return 吞掉 → 子代理永远停在「运行中」。
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    const deps = { tasks: new TaskTracker(), subagents, tools: new ToolLifecycleTracker() };
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "Explore", description: "调研 XXX" }), (e) => events.push(e), deps);
    mapSdkMessage(agentLaunchAck("a1"), (e) => events.push(e), deps);
    events.length = 0;
    const spy = vi.spyOn(tailMod, "stopOutputTail");
    mapSdkMessage(
      taskNotificationFrame({ tool_use_id: "a1", task_id: "ad0a04aa19328f37b", status: "completed", summary: "完整报告…" }),
      (e) => events.push(e),
      deps,
    );
    expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "完整报告…", is_error: false }]);
    expect(subagents.isActive("a1")).toBe(false);
    expect(spy).toHaveBeenCalledWith("a1");
    spy.mockRestore();
  });

  it("structured 终态 status 非 completed → is_error:true（async 子代理）", () => {
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    const deps = { tasks: new TaskTracker(), subagents, tools: new ToolLifecycleTracker() };
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "Explore", description: "调研 XXX" }), (e) => events.push(e), deps);
    mapSdkMessage(agentLaunchAck("a1"), (e) => events.push(e), deps);
    events.length = 0;
    mapSdkMessage(taskNotificationFrame({ tool_use_id: "a1", task_id: "t9", status: "failed", summary: "model 不存在" }), (e) => events.push(e), deps);
    expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "model 不存在", is_error: true }]);
  });

  it("前台子代理的 structured 终态不收尾——真结果仍由 tool_result 决定", () => {
    // 前台子代理两帧同刻到达（顺序不定）：structured 先到也不能收，否则结果从
    // tool_result 的全文降级成 summary，且紧随的 tool_result 会掉进通用分支。
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    const deps = { tasks: new TaskTracker(), subagents, tools: new ToolLifecycleTracker() };
    mapSdkMessage(assistantToolUse("a1", "Agent", { subagent_type: "Explore", description: "调研 XXX" }), (e) => events.push(e), deps);
    events.length = 0;
    mapSdkMessage(taskNotificationFrame({ tool_use_id: "a1", task_id: "t9", status: "completed", summary: "OK" }), (e) => events.push(e), deps);
    expect(events).toEqual([]);
    expect(subagents.isActive("a1")).toBe(true);
    mapSdkMessage(userToolResult("a1", "调研结论：用了 Vue3+Tauri。"), (e) => events.push(e), deps);
    expect(events).toEqual([{ type: "subagent_end", id: "a1", result: "调研结论：用了 Vue3+Tauri。", is_error: false }]);
    expect(subagents.isActive("a1")).toBe(false);
  });

  it("普通 user 文本消息（非 task-notification）不被误当完成", () => {
    const events: ChatEvent[] = [];
    const tasks = new TaskTracker();
    const subagents = new SubagentTracker();
    const tools = new ToolLifecycleTracker();
    const plain = { type: "user", message: { role: "user", content: "用户随手打的一句话" } };
    mapSdkMessage(plain,
  (e) => events.push(e),
  { tasks: tasks, subagents: subagents, tools: tools });
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
    mapSdkMessage(systemInit("s1", ["clear", "compact", "code-review"]),
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
    expect(events).toEqual([
      { type: "session_init", session_id: "s1" },
      { type: "slash_commands_available", commands: ["clear", "compact", "code-review"] },
    ]);
  });

  it("slash_commands 是空数组时，仍然发出（不是缺省不发）", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(systemInit("s1", []),
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
    expect(events).toEqual([
      { type: "session_init", session_id: "s1" },
      { type: "slash_commands_available", commands: [] },
    ]);
  });

  it("slash_commands 字段缺失时（旧版 CLI），只发 session_init", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(systemInit("s1"),
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
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

describe("mapSdkMessage 子代理嵌套软警告（warn-only）", () => {
  const tasks = () => new TaskTracker();
  const tools = () => new ToolLifecycleTracker();

  it("顶层派子代理（depth 1）不发警告", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(assistantToolUse("a1", "Agent", { description: "顶层" }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: new SubagentTracker(), tools: tools() });
    expect(events.find((e) => e.type === "subagent_nesting_warning")).toBeUndefined();
  });

  it("子代理内部再派子代理（depth 2 > 阈值 1）触发警告", () => {
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { description: "顶层" }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    events.length = 0;
    // a1 内部又调 Agent（sidechain，parent_tool_use_id=a1）→ depth 2
    mapSdkMessage(assistantToolUse("a2", "Agent", { description: "嵌套" }, "a1"),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    const warn = events.find((e) => e.type === "subagent_nesting_warning") as any;
    expect(warn).toBeDefined();
    expect(warn.depth).toBe(2);
    expect(warn.threshold).toBe(1);
  });

  it("子代理内部调非 Agent 工具不发警告", () => {
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    mapSdkMessage(assistantToolUse("a1", "Agent", { description: "顶层" }),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    events.length = 0;
    mapSdkMessage(assistantToolUse("r1", "Read", { file_path: "x.ts" }, "a1"),
  (e) => events.push(e),
  { tasks: tasks(), subagents: subagents, tools: tools() });
    expect(events.find((e) => e.type === "subagent_nesting_warning")).toBeUndefined();
  });
});

describe("isErrorResult（F3：错误终态判定——turnMessages 的 terminate 信号源）", () => {
  it("干净成功 result → false", () => {
    expect(isErrorResult({ type: "result", subtype: "success", is_error: false })).toBe(false);
  });
  it("错误 subtype → true", () => {
    expect(isErrorResult({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["API Error: 401"] })).toBe(true);
    expect(isErrorResult({ type: "result", subtype: "error_max_turns" })).toBe(true);
  });
  it("success subtype 但 is_error:true（429 等运行时实证形态）→ true", () => {
    expect(isErrorResult({ type: "result", subtype: "success", is_error: true, api_error_status: 429 })).toBe(true);
  });
  it("良性打断（error_during_execution 且无用户可读错误）→ false（B5 契约：interrupt 后原 query 存活）", () => {
    expect(isErrorResult({ type: "result", subtype: "error_during_execution" })).toBe(false);
    expect(isErrorResult({ type: "result", subtype: "error_during_execution", errors: ["[ede_diagnostic] result_type=user"] })).toBe(false);
  });
  it("打断形状但带 api_error_status / 可读错误 → 不是良性，true", () => {
    expect(isErrorResult({ type: "result", subtype: "error_during_execution", api_error_status: 500 })).toBe(true);
    expect(isErrorResult({ type: "result", subtype: "error_during_execution", result: "provider 炸了" })).toBe(true);
  });
});
