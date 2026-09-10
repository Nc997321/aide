import { describe, it, expect } from "vitest";
import { BgTaskTracker, parseBackgroundAck } from "./bgTasks.js";
import { mapSdkMessage } from "../engine/mapper.js";
import { TaskTracker } from "../engine/tasks.js";
import { SubagentTracker } from "../engine/subagents.js";
import { ToolLifecycleTracker } from "../engine/toolLifecycle.js";
import type { ChatEvent } from "../engine/types.js";

// ---- parseBackgroundAck：claude.exe 实锤的两种回执变体 ----

describe("parseBackgroundAck", () => {
  it("parses the full variant with 'You will be notified' suffix", () => {
    const content =
      "Command running in background with ID: b8fc44e9d. Output is being written to: C:\\Users\\<user>\\.claude\\tasks\\b8fc44e9d.output. You will be notified when it completes. To check interim output, use BashOutput on the task.";
    expect(parseBackgroundAck(content)).toEqual({
      taskId: "b8fc44e9d",
      outputFile: "C:\\Users\\<user>\\.claude\\tasks\\b8fc44e9d.output",
    });
  });

  it("parses the short variant ending at end of string", () => {
    const content = "Backgrounded. ID: abc123. Output is being written to: /tmp/tasks/abc123.output";
    expect(parseBackgroundAck(content)).toEqual({ taskId: "abc123", outputFile: "/tmp/tasks/abc123.output" });
  });

  it("strips a trailing sentence period from the path", () => {
    const content = "ID: abc123. Output is being written to: /tmp/tasks/abc123.output.\n";
    expect(parseBackgroundAck(content)).toEqual({ taskId: "abc123", outputFile: "/tmp/tasks/abc123.output" });
  });

  it("returns null for normal tool results", () => {
    expect(parseBackgroundAck("total 8\n-rw-r--r-- 1 user user 12 Jan 1 a.ts")).toBeNull();
    expect(parseBackgroundAck("")).toBeNull();
  });
});

// ---- BgTaskTracker 状态机 ----

describe("BgTaskTracker", () => {
  it("registerStarted accepts backgrounded bash and enriches from noted Bash input", () => {
    const t = new BgTaskTracker();
    t.noteBashToolUse("tu1", { command: "pnpm dev", description: "start dev server", run_in_background: true });
    const ev = t.registerStarted({
      task_id: "t1",
      tool_use_id: "tu1",
      task_type: "local_bash",
      description: "start dev server",
    });
    expect(ev).toEqual({
      type: "bg_task_started",
      id: "t1",
      toolUseId: "tu1",
      command: "pnpm dev",
      description: "start dev server",
    });
  });

  // 2026-07-25 实锤：CLI 对【前台】Bash 也发 task_started（前台命令也建临时 .output、
  // 跑完即删），task_type 同样是 local_bash——不拦就会把每个前台命令误登记成
  // 「后台任务」，面板有任务、输出永远空白。
  it("ignores task_started for FOREGROUND bash (the local_bash trap)", () => {
    const t = new BgTaskTracker();
    t.noteBashToolUse("tu1", { command: "ls", run_in_background: false });
    t.noteBashToolUse("tu2", { command: "pwd" }); // 缺省也算前台
    expect(t.registerStarted({ task_id: "f1", tool_use_id: "tu1", task_type: "local_bash" })).toBeNull();
    expect(t.registerStarted({ task_id: "f2", tool_use_id: "tu2", task_type: "local_bash" })).toBeNull();
    expect(t.has("f1")).toBe(false);
    expect(t.has("f2")).toBe(false);
  });

  it("ignores non-bash task types, unknown tool_use_id and skip_transcript ambient tasks", () => {
    const t = new BgTaskTracker();
    expect(t.registerStarted({ task_id: "a1", tool_use_id: "x", task_type: "local_agent" })).toBeNull();
    expect(t.registerStarted({ task_id: "w1", tool_use_id: "x", task_type: "local_workflow" })).toBeNull();
    expect(t.registerStarted({ task_id: "u1", task_type: "local_bash" })).toBeNull(); // 无 tool_use_id
    expect(t.registerStarted({ task_id: "u2", tool_use_id: "unknown", task_type: "local_bash" })).toBeNull(); // 未知 tool_use
    t.noteBashToolUse("tu9", { command: "x", run_in_background: true });
    expect(t.registerStarted({ task_id: "h1", tool_use_id: "tu9", task_type: "local_bash", skip_transcript: true })).toBeNull();
    expect(t.has("a1")).toBe(false);
  });

  it("registerAck merges with a prior task_started and returns outputFile", () => {
    const t = new BgTaskTracker();
    t.noteBashToolUse("tu1", { command: "pnpm dev", run_in_background: true });
    t.registerStarted({ task_id: "t1", tool_use_id: "tu1", task_type: "local_bash" });
    const r = t.registerAck("tu1", "Command running in background with ID: t1. Output is being written to: /tmp/t1.output. You will be notified when it completes.");
    expect(r?.taskId).toBe("t1");
    expect(r?.outputFile).toBe("/tmp/t1.output");
    expect(r?.event).toMatchObject({ type: "bg_task_started", id: "t1", toolUseId: "tu1", command: "pnpm dev", outputFile: "/tmp/t1.output" });
  });

  it("handleTaskUpdated：结构化 patch.status 终态收尾，非终态 patch 忽略", () => {
    const t = new BgTaskTracker();
    t.noteBashToolUse("tu1", { command: "x", run_in_background: true });
    t.registerStarted({ task_id: "t1", tool_use_id: "tu1", task_type: "local_bash" });
    // 非终态 patch：忽略
    expect(t.handleTaskUpdated({ task_id: "t1", patch: { is_backgrounded: true } })).toBeNull();
    expect(t.handleTaskUpdated({ task_id: "t1", patch: { status: "running" } })).toBeNull();
    // 终态：收尾一次
    expect(t.handleTaskUpdated({ task_id: "t1", patch: { status: "completed" } }))
      .toEqual({ type: "bg_task_ended", id: "t1", status: "completed" });
    expect(t.handleTaskUpdated({ task_id: "t1", patch: { status: "failed" } })).toBeNull(); // done 守卫
    expect(t.handleTaskUpdated({ task_id: "unknown", patch: { status: "completed" } })).toBeNull();
  });

  it("stopAllRunning：会话终结时把所有 running 任务标 stopped（已结束的不动）", () => {
    const t = new BgTaskTracker();
    t.noteBashToolUse("tu1", { command: "a", run_in_background: true });
    t.noteBashToolUse("tu2", { command: "b", run_in_background: true });
    t.registerStarted({ task_id: "t1", tool_use_id: "tu1", task_type: "local_bash" });
    t.registerStarted({ task_id: "t2", tool_use_id: "tu2", task_type: "local_bash" });
    t.handleXmlNotification("t1", "completed");
    const events = t.stopAllRunning();
    expect(events).toEqual([{ type: "bg_task_ended", id: "t2", status: "stopped" }]);
    expect(t.stopAllRunning()).toEqual([]); // 幂等
  });

  it("handleNotification emits ended only for tracked tasks, once", () => {
    const t = new BgTaskTracker();
    t.noteBashToolUse("tu1", { command: "x", run_in_background: true });
    t.registerStarted({ task_id: "t1", tool_use_id: "tu1", task_type: "local_bash" });
    const ev = t.handleNotification({ task_id: "t1", status: "failed", summary: "exit 1", usage: { duration_ms: 1234 } });
    expect(ev).toEqual({ type: "bg_task_ended", id: "t1", status: "failed", summary: "exit 1", durationMs: 1234 });
    // 重复通知 / 未知任务（含前台 Bash 的 task_notification）都不再发
    expect(t.handleNotification({ task_id: "t1", status: "completed" })).toBeNull();
    expect(t.handleNotification({ task_id: "other", status: "completed" })).toBeNull();
  });
});

// ---- mapSdkMessage 全链路 ----

function assistantBashToolUse(id: string, command: string) {
  return {
    type: "assistant",
    message: { model: "claude-x", content: [{ type: "tool_use", id, name: "Bash", input: { command, run_in_background: true } }] },
  };
}

function userToolResult(id: string, content: string) {
  return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] } };
}

describe("mapSdkMessage background bash pipeline", () => {
  function setup() {
    const events: ChatEvent[] = [];
    const started: string[] = [];
    const stopped: string[] = [];
    const hooks = {
      tracker: new BgTaskTracker(),
      startTail: (id: string, _file: string) => started.push(id),
      stopTail: (id: string) => stopped.push(id),
    };
    const emit = (e: ChatEvent) => events.push(e);
    const call = (msg: any) =>
      mapSdkMessage(msg,
  emit,
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker(), bgTaskHooks: hooks });
    return { events, started, stopped, call };
  }

  it("task_started → ack → notification 全序列（ack 仍走通用 tool_result）", () => {
    const { events, started, stopped, call } = setup();
    call(assistantBashToolUse("tu1", "pnpm dev"));
    call({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", task_type: "local_bash", description: "dev" });
    call(userToolResult("tu1", "Command running in background with ID: t1. Output is being written to: /tmp/t1.output. You will be notified when it completes."));
    call({ type: "system", subtype: "task_notification", task_id: "t1", status: "completed", summary: "done", usage: { duration_ms: 500 } });

    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_use_start", "bg_task_started", "bg_task_started", "tool_result", "bg_task_ended"]);
    expect(events[1]).toMatchObject({ id: "t1", toolUseId: "tu1", command: "pnpm dev" });
    expect(events[2]).toMatchObject({ id: "t1", outputFile: "/tmp/t1.output" });
    expect(events[3]).toMatchObject({ type: "tool_result", id: "tu1" }); // 回执文本照常进工具卡
    expect(events[4]).toMatchObject({ id: "t1", status: "completed", summary: "done", durationMs: 500 });
    expect(started).toEqual(["t1"]);
    expect(stopped).toEqual(["t1"]);
  });

  it("ack 先于 task_started 到达：ack 单独成任务（回执后 bashInputs 已清，迟到的 task_started 忽略）", () => {
    const { events, started, call } = setup();
    call(assistantBashToolUse("tu1", "pnpm dev"));
    call(userToolResult("tu1", "Command running in background with ID: t1. Output is being written to: /tmp/t1.output. You will be notified when it completes."));
    call({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1", task_type: "local_bash", description: "dev" });
    const starts = events.filter((e) => e.type === "bg_task_started");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ id: "t1", command: "pnpm dev", outputFile: "/tmp/t1.output" });
    expect(started).toEqual(["t1"]);
  });

  it("前台 Bash 全链路不产生任何 bg_task 事件（task_started/task_notification 都被忽略）", () => {
    const { events, started, stopped, call } = setup();
    call({
      type: "assistant",
      message: { model: "claude-x", content: [{ type: "tool_use", id: "tu9", name: "Bash", input: { command: "ls" } }] },
    });
    call({ type: "system", subtype: "task_started", task_id: "f1", tool_use_id: "tu9", task_type: "local_bash" });
    call(userToolResult("tu9", "a.ts\nb.ts"));
    call({ type: "system", subtype: "task_notification", task_id: "f1", status: "completed" });
    expect(events.map((e) => e.type)).toEqual(["tool_use_start", "tool_result"]);
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it("非 local_bash 的 task_started / 未知 task_notification 不产生事件", () => {
    const { events, stopped, call } = setup();
    call({ type: "system", subtype: "task_started", task_id: "a1", task_type: "local_agent", description: "agent" });
    call({ type: "system", subtype: "task_notification", task_id: "a1", status: "completed" });
    call({ type: "system", subtype: "task_progress", task_id: "a1" });
    expect(events).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it("TaskOutput(block) 流程：工具结果里的终态收尾任务，running 状态不收", () => {
    const { events, started, stopped, call } = setup();
    call(assistantBashToolUse("tu1", "ping -n 30 127.0.0.1"));
    call(userToolResult("tu1", "Command running in background with ID: t1. Output is being written to: /tmp/t1.output. You will be notified when it completes."));
    // 模型先用 TaskOutput 探了一次（还在跑）→ 不收尾
    call(userToolResult("tu2", "<retrieval_status>success</retrieval_status>\n\n<task_id>t1</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>running</status>\n\n<output>\nPinging...\n</output>"));
    expect(events.filter((e) => e.type === "bg_task_ended")).toHaveLength(0);
    // block:true 等到结束 → 工具结果即终态信号
    call(userToolResult("tu3", "<retrieval_status>success</retrieval_status>\n\n<task_id>t1</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>completed</status>\n\n<exit_code>0</exit_code>\n\n<output>\n...\n</output>"));
    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_use_start", "bg_task_started", "tool_result", "tool_result", "bg_task_ended", "tool_result"]);
    expect(events[4]).toMatchObject({ id: "t1", status: "completed" });
    expect(started).toEqual(["t1"]);
    expect(stopped).toEqual(["t1"]);
    // 随后 XML 通知若也到（双通道），done 守卫去重
    call({
      type: "user",
      message: { content: `<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>completed</status>\n<summary>x</summary>` },
    });
    expect(events).toHaveLength(6);
  });

  // 2026-07-25 真实转录实锤：local_bash 的终态走 <task-notification> XML 用户消息
  // （与 async 子代理同通道），不是 structured system/task_notification。
  it("XML task-notification 收尾后台任务（killed 归一为 stopped）", () => {
    const { events, started, stopped, call } = setup();
    const xml = (taskId: string, tu: string, status: string) => ({
      type: "user",
      message: {
        content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${tu}</tool-use-id>\n<output-file>C:\\tmp\\${taskId}.output</output-file>\n<status>${status}</status>\n<summary>Background command completed</summary>`,
      },
    });
    call(assistantBashToolUse("tu1", "ping -n 68 127.0.0.1"));
    call(userToolResult("tu1", "Command running in background with ID: t1. Output is being written to: /tmp/t1.output. You will be notified when it completes."));
    call(xml("t1", "tu1", "killed"));
    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_use_start", "bg_task_started", "tool_result", "bg_task_ended"]);
    expect(events[3]).toMatchObject({ id: "t1", status: "stopped", summary: "Background command completed" });
    expect(started).toEqual(["t1"]);
    expect(stopped).toEqual(["t1"]);
    // 重复 XML 通知（done 守卫）与未知任务的 XML 都不再发
    call(xml("t1", "tu1", "completed"));
    call(xml("other", "tu2", "completed"));
    expect(events).toHaveLength(4);
  });

  it("无 bgTaskHooks 时后台回执只是普通 tool_result（向后兼容）", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(userToolResult("tu1", "Command running in background with ID: t1. Output is being written to: /tmp/t1.output. You will be notified when it completes."),
  (e) => events.push(e),
  { tasks: new TaskTracker(), subagents: new SubagentTracker(), tools: new ToolLifecycleTracker() });
    expect(events.map((e) => e.type)).toEqual(["tool_result"]);
  });
});
