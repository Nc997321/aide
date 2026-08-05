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

describe("TaskTracker.reset", () => {
  // 回归：顶部 TODO 跨轮累积根因——TaskTracker 的 Map 只增不清，旧轮已完成
  // 的 task 一直留在 snapshot() 里。新一轮用户消息开始时必须 reset，让新一轮
  // 的 TODO 覆盖旧轮而不是追加。
  it("clears all resolved tasks", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "旧轮任务" });
    t.handleToolResult("u1", "Task #1 created successfully: 旧轮任务");
    t.handleToolUse("u2", "TaskUpdate", { taskId: "1", status: "completed" });
    expect(t.snapshot()).toHaveLength(1);

    t.reset();

    expect(t.snapshot()).toEqual([]);
  });

  it("clears pending creates (in-flight TaskCreate without a result yet)", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "还没拿到 id 的任务" });
    expect(t.snapshot()).toEqual([]);

    t.reset();

    // reset 后即使迟到的 tool_result 到达，也不应再把旧轮任务加回来
    const outcome = t.handleToolResult("u1", "Task #1 created successfully: 还没拿到 id 的任务");
    expect(outcome).toEqual({ tracked: false, changed: false });
    expect(t.snapshot()).toEqual([]);
  });

  it("clears tracked ids so a stray late tool_result for an old tool_use is not swallowed", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "旧轮" });
    t.handleToolUse("u2", "TaskList", {});

    t.reset();

    // reset 后这些 id 不再被认作任务工具的结果，应回退为 tracked:false（通用 tool_result）
    expect(t.handleToolResult("u2", JSON.stringify({ tasks: [] }))).toEqual({ tracked: false, changed: false });
  });

  it("allows building a fresh task list after reset (new round replaces, not appends)", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "旧轮任务" });
    t.handleToolResult("u1", "Task #1 created successfully: 旧轮任务");

    t.reset();

    t.handleToolUse("u3", "TaskCreate", { subject: "新轮任务" });
    t.handleToolResult("u3", "Task #2 created successfully: 新轮任务");
    expect(t.snapshot()).toEqual([
      { id: "2", subject: "新轮任务", status: "pending", activeForm: undefined },
    ]);
  });
});

describe("TaskTracker.markResetOnNextCreate", () => {
  function createResolved(t: TaskTracker, toolUseId: string, taskId: string, subject: string) {
    t.handleToolUse(toolUseId, "TaskCreate", { subject });
    t.handleToolResult(toolUseId, `Task #${taskId} created successfully: ${subject}`);
  }

  // 回归：原每轮 send 立即 reset() 清空 tasks，导致 (1) 旧轮 TODO 瞬间消失；
  // (2) 新轮 Claude 用 TaskUpdate 推进旧 task 时旧 taskId 已被清，在 handleToolUse
  // 里查不到 existing 被防御性丢弃（changed=false），且 tool_result 被标 tracked:true
  // 吞掉——todo 推进信号彻底丢失。markResetOnNextCreate 保留 tasks，仅在新轮首个
  // 新 TaskCreate 落地时覆盖，修复这两条。

  it("旧轮 TODO 标记后仍可见，等新轮首个 TaskCreate 落地才覆盖；后续 TaskCreate 追加", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "1", "A");
    t.handleToolUse("u2", "TaskUpdate", { taskId: "1", status: "completed" });
    createResolved(t, "u3", "2", "B");
    t.handleToolUse("u4", "TaskUpdate", { taskId: "2", status: "in_progress" });
    expect(t.snapshot()).toHaveLength(2);

    t.markResetOnNextCreate();
    // 过渡期：旧轮 TODO 仍可见（不立即清）
    expect(t.snapshot()).toHaveLength(2);

    // 新轮首个 TaskCreate 落地 → 覆盖旧列表
    t.handleToolUse("u5", "TaskCreate", { subject: "C" });
    expect(t.handleToolResult("u5", "Task #3 created successfully: C")).toEqual({ tracked: true, changed: true });
    expect(t.snapshot()).toEqual([
      { id: "3", subject: "C", status: "pending", activeForm: undefined },
    ]);

    // 同轮第二个 TaskCreate 追加，不重复清
    t.handleToolUse("u6", "TaskCreate", { subject: "D" });
    t.handleToolResult("u6", "Task #4 created successfully: D");
    expect(t.snapshot()).toEqual([
      { id: "3", subject: "C", status: "pending", activeForm: undefined },
      { id: "4", subject: "D", status: "pending", activeForm: undefined },
    ]);
  });

  it("标记后新轮仅 TaskUpdate 旧 task → 旧 taskId 仍命中并推进（原 reset() 下会被吞）", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "1", "A");
    t.handleToolUse("u2", "TaskUpdate", { taskId: "1", status: "in_progress" });
    createResolved(t, "u3", "2", "B");
    expect(t.snapshot()[0].status).toBe("in_progress");

    t.markResetOnNextCreate();
    expect(t.snapshot()).toHaveLength(2); // 旧轮 TODO 保留

    // 新轮用旧 taskId 推进 —— 命中（reset() 下 existing 会被清，changed=false）
    const changed = t.handleToolUse("u4", "TaskUpdate", { taskId: "1", status: "completed" });
    expect(changed).toBe(true);
    expect(t.snapshot()).toEqual([
      { id: "1", subject: "A", status: "completed", activeForm: undefined },
      { id: "2", subject: "B", status: "pending", activeForm: undefined },
    ]);
    // tool_result tracked 但快照不变
    expect(t.handleToolResult("u4", "Updated task #1 status")).toEqual({ tracked: true, changed: false });

    // 覆盖标志仍未被消费（无新 TaskCreate）——继续推进 B 也能命中
    expect(t.handleToolUse("u5", "TaskUpdate", { taskId: "2", status: "in_progress" })).toBe(true);
    expect(t.snapshot()[1].status).toBe("in_progress");
  });

  it("标记后新轮无任何 Task 工具 → 旧 tasks 原样保留", () => {
    const t = new TaskTracker();
    createResolved(t, "u1", "1", "A");
    createResolved(t, "u2", "2", "B");

    t.markResetOnNextCreate();
    expect(t.snapshot()).toEqual([
      { id: "1", subject: "A", status: "pending", activeForm: undefined },
      { id: "2", subject: "B", status: "pending", activeForm: undefined },
    ]);
  });

  it("标记后清掉 trackedIds，跨轮迟到的旧 tool_result 回退通用 tool_result（保留原 reset 防御）", () => {
    const t = new TaskTracker();
    t.handleToolUse("u1", "TaskCreate", { subject: "旧轮" });
    t.handleToolUse("u2", "TaskList", {});

    t.markResetOnNextCreate();

    expect(t.handleToolResult("u2", JSON.stringify({ tasks: [] }))).toEqual({ tracked: false, changed: false });
  });
});