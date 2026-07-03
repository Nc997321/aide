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
