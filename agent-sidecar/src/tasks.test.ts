import { describe, it, expect } from "vitest";
import { TaskTracker, extractCreatedTaskId } from "./tasks.js";

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

describe("extractCreatedTaskId", () => {
  // SDK 0.3.197 起返回纯文本（实测），不再是 0.3.142 文档所述的 JSON。
  it("parses the SDK 0.3.197 plain-text result", () => {
    expect(extractCreatedTaskId("Task #1 created successfully: 列出当前目录的文件")).toBe("1");
    expect(extractCreatedTaskId("Task #42 created successfully: 任意 subject")).toBe("42");
  });

  it("returns undefined for unparseable content", () => {
    expect(extractCreatedTaskId("not json")).toBeUndefined();
    expect(extractCreatedTaskId(JSON.stringify({ task: { subject: "写测试" } }))).toBeUndefined();
    expect(extractCreatedTaskId("")).toBeUndefined();
    expect(extractCreatedTaskId("Updated task #1 status")).toBeUndefined();
  });
});

describe("TaskTracker create lifecycle", () => {
  it("does not add to the snapshot until the create's tool_result resolves", () => {
    const t = new TaskTracker();
    const changed = t.handleToolUse("u1", "TaskCreate", { subject: "写测试", activeForm: "正在写测试" });
    expect(changed).toBe(false);
    expect(t.snapshot()).toEqual([]);
  });

  it("adds a pending task once the create result carries an id (SDK 0.3.197 plain text)", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "写测试", activeForm: "正在写测试" });
    const outcome = t.handleToolResult("u1", "Task #1 created successfully: 写测试");
    expect(outcome).toEqual({ tracked: true, changed: true });
    expect(t.snapshot()).toEqual([
      { id: "1", subject: "写测试", status: "pending", activeForm: "正在写测试" },
    ]);
  });

  it("silently drops a create whose result cannot be parsed", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "写测试" });
    const outcome = t.handleToolResult("u1", "not a task-created line");
    expect(outcome).toEqual({ tracked: true, changed: false });
    expect(t.snapshot()).toEqual([]);
  });
});

describe("TaskTracker update lifecycle", () => {
  // 复刻真实流：TaskCreate 的 tool_result 是 SDK 0.3.197 纯文本，taskId 是纯数字字符串。
  function createResolved(t: TaskTracker, toolUseId: string, taskId: string, subject: string) {
    t.handleToolUse(toolUseId, "TaskCreate", { subject });
    t.handleToolResult(toolUseId, `Task #${taskId} created successfully: ${subject}`);
  }

  it("patches status via the canonical taskId field", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "1", "写测试");
    const changed = t.handleToolUse("u2", "TaskUpdate", { taskId: "1", status: "in_progress" });
    expect(changed).toBe(true);
    expect(t.snapshot()).toEqual([
      { id: "1", subject: "写测试", status: "in_progress", activeForm: undefined },
    ]);
  });

  it("falls back to id/task_id and active_form when the canonical names are absent", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "1", "写测试");
    const changed = t.handleToolUse("u2", "TaskUpdate", {
      id: "1",
      status: "in_progress",
      active_form: "正在写测试",
    });
    expect(changed).toBe(true);
    expect(t.snapshot()).toEqual([
      { id: "1", subject: "写测试", status: "in_progress", activeForm: "正在写测试" },
    ]);
  });

  it("removes the task when status is deleted", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "1", "写测试");
    const changed = t.handleToolUse("u2", "TaskUpdate", { taskId: "1", status: "deleted" });
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
    createResolved(t, "u1", "1", "写测试");
    const changed = t.handleToolUse("u2", "TaskUpdate", { taskId: "1", status: "bogus" });
    expect(changed).toBe(true);
    expect(t.snapshot()[0].status).toBe("pending");
  });
});

describe("TaskTracker read-only tools", () => {
  it("TaskGet/TaskList do not change the snapshot and their results are swallowed", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "写测试" });
    t.handleToolResult("u1", "Task #1 created successfully: 写测试");
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