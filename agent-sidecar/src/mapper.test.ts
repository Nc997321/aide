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
