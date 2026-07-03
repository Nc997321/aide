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
