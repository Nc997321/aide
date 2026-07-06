import { describe, it, expect } from "vitest";
import { PermissionManager } from "./permissions.js";
import { SubagentTracker } from "./subagents.js";
import type { ChatEvent } from "./types.js";

describe("PermissionManager — AskUserQuestion answers 重组", () => {
  it("approving AskUserQuestion rebuilds updatedInput as {questions, answers} instead of echoing input", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const input = { questions: [{ question: "用什么颜色？", header: "配色", options: [{ label: "蓝色", description: "冷色调" }] }] };
    const resultPromise = callback("AskUserQuestion", input, {});

    const id = (events[0] as any).id;
    mgr.resolve(id, true, undefined, { "用什么颜色？": "蓝色" });

    const result = await resultPromise;
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { questions: input.questions, answers: { "用什么颜色？": "蓝色" } },
    });
  });

  it("still echoes raw input unchanged for ordinary tools (no regression)", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const input = { command: "ls" };
    const resultPromise = callback("Bash", input, {});
    const id = (events[0] as any).id;
    mgr.resolve(id, true, undefined, undefined);

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("denying AskUserQuestion returns deny, ignoring any stray answers", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const resultPromise = callback("AskUserQuestion", { questions: [] }, {});
    const id = (events[0] as any).id;
    mgr.resolve(id, false);

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "deny", message: "用户拒绝" });
  });

  it("approving a non-AskUserQuestion tool ignores an answers payload (defensive: no accidental reshape)", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const input = { file_path: "x.ts" };
    const resultPromise = callback("Write", input, {});
    const id = (events[0] as any).id;
    // 即便前端误传了 answers，非 AskUserQuestion 工具也不该被重塑
    mgr.resolve(id, true, undefined, { "some question": "some answer" });

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });
});

// 回归：用户反馈"点了总是允许，还得手动切自动模式"——根因是按钮永远显示同一句
// "总是允许"，掩盖了 SDK 实际建议的是"给这个工具加规则"还是"整个会话切权限模式"
// （比如 Edit 常见的 setMode → acceptEdits，session 级、不落盘）。这里验证
// permission_request 事件如实带出 alwaysAllowLabel，前端按钮据此换文案，而不是
// 一律显示看不出差别的「总是允许」。
describe("PermissionManager — alwaysAllowLabel 如实反映 suggestions（不再一律显示同一句「总是允许」）", () => {
  it("没有 suggestions 时不给 alwaysAllowLabel（前端自己兜底显示「总是允许」）", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e))("Bash", { command: "ls" }, {});
    expect((events[0] as any).alwaysAllowLabel).toBeUndefined();
  });

  it("suggestions 只有 addRules（如 Bash 按命令前缀）时用通用「总是允许」文案", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e))("Bash", { command: "ls" }, {
      suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls*" }], behavior: "allow", destination: "projectSettings" }],
    });
    expect((events[0] as any).alwaysAllowLabel).toBe("总是允许");
  });

  it("suggestions 带 setMode: acceptEdits 时明确标出「本次会话」、不是持久化规则", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e))("Edit", { file_path: "x.ts" }, {
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect((events[0] as any).alwaysAllowLabel).toBe("自动接受编辑（本次会话）");
  });

  it("suggestions 带 setMode: bypassPermissions 时标成危险文案，供前端标红", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e))("Bash", { command: "rm -rf x" }, {
      suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    });
    expect((events[0] as any).alwaysAllowLabel).toBe("自动模式：跳过所有确认（本次会话）");
  });
});

// 回归：子代理内部工具触发权限请求时，SDK 会带一个 agentID（Hooks 文档确认它和
// 具体 tool_use_id 是两个不同字段）——用户看到权限框弹出来时完全不知道是主线程
// 还是某个子代理在问，尤其子代理没有独立窗口、只有一张可折叠进度卡片。这里验证
// fromSubagent 如实反映 agentID，并借 SubagentTracker 翻成人看得懂的 agentName。
describe("PermissionManager — fromSubagent（标注这次请求来自哪个子代理）", () => {
  it("没有 agentID 时不带 fromSubagent（主线程请求，前端按老样子展示）", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e))("Bash", { command: "ls" }, {});
    expect((events[0] as any).fromSubagent).toBeUndefined();
  });

  it("agentID 命中 SubagentTracker 时，fromSubagent 带上真实 agentName", async () => {
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    subagents.handleToolUse("a1", { subagent_type: "code-reviewer", description: "审查 PR" });
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e), subagents)("Bash", { command: "ls" }, { agentID: "a1" });
    expect((events[0] as any).fromSubagent).toEqual({ id: "a1", agentName: "code-reviewer" });
  });

  it("agentID 查不到名字时兜底成通用「子代理」，而不是丢弃这个信息", async () => {
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e), subagents)("Bash", { command: "ls" }, { agentID: "ghost" });
    expect((events[0] as any).fromSubagent).toEqual({ id: "ghost", agentName: "子代理" });
  });

  it("没有传 subagents 时也不报错，agentID 存在就兜底成通用「子代理」", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e))("Bash", { command: "ls" }, { agentID: "a1" });
    expect((events[0] as any).fromSubagent).toEqual({ id: "a1", agentName: "子代理" });
  });
});

/** 搭一个带事件收集的 manager + 回调，下面几组测试共用。 */
function setup() {
  const events: ChatEvent[] = [];
  const mgr = new PermissionManager();
  const callback = mgr.makeCallback((e) => events.push(e));
  const requestIds = () =>
    events.filter((e) => e.type === "permission_request").map((e) => (e as any).id as string);
  const cancelledIds = () =>
    events.filter((e) => e.type === "permission_cancelled").map((e) => (e as any).id as string);
  return { events, mgr, callback, requestIds, cancelledIds };
}

// 回归：用户反馈"权限按钮永远不会自动变"——CLI 会根据回答（如「总是允许」携带的
// setMode 建议）自动切权限模式，但 sidecar 此前不知道模式变了、也不广播。resolve
// 现在返回 appliedMode，入口层据此对齐 currentPermissionMode 并广播给前端下拉。
describe("PermissionManager — resolve 返回 ResolveOutcome（模式联动 + 队列连带放行）", () => {
  it("信号已中止时直接拒绝，不发 permission_request、不挂 Promise（永久悬置回归）", async () => {
    const { callback, events } = setup();
    const ac = new AbortController();
    ac.abort();
    const result = await callback("Read", { file_path: "a.ts" }, { signal: ac.signal });
    expect(result).toMatchObject({ behavior: "deny" });
    expect(events).toEqual([]);
  });

  it("普通批准：返回工具名、无 appliedMode", async () => {
    const { mgr, callback, requestIds } = setup();
    const p = callback("Bash", { command: "ls" }, {});
    const outcome = mgr.resolve(requestIds()[0], true);
    expect(outcome).toEqual({ toolName: "Bash" });
    expect(((await p) as any).behavior).toBe("allow");
  });

  it("总是允许携带 setMode 建议：返回 appliedMode，供入口层广播（模式按钮不自动变的根治回归）", async () => {
    const { mgr, callback, requestIds } = setup();
    const p = callback("Edit", { file_path: "a.ts" }, {
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    const outcome = mgr.resolve(requestIds()[0], true, true);
    expect(outcome).toEqual({ toolName: "Edit", appliedMode: "acceptEdits" });
    const result = (await p) as any;
    expect(result.behavior).toBe("allow");
    expect(result.updatedPermissions).toEqual([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);
  });

  it("总是允许落盘裸工具名规则：连带放行队列中同名工具，异名工具保持挂起", async () => {
    const { mgr, callback, requestIds, cancelledIds } = setup();
    // 无 suggestions → resolve 时落盘裸 {toolName:"Read"} allow 规则，定义上覆盖一切 Read
    const p1 = callback("Read", { file_path: "a.java" }, {});
    const p2 = callback("Read", { file_path: "b.java" }, {});
    let bashSettled = false;
    void callback("Bash", { command: "ls" }, {}).then(() => { bashSettled = true; });

    const [id1, id2] = requestIds();
    mgr.resolve(id1, true, true);

    // 同名 Read 被连带放行（不重复携带 updatedPermissions），并通知前端出队
    expect(((await p1) as any).behavior).toBe("allow");
    const r2 = (await p2) as any;
    expect(r2.behavior).toBe("allow");
    expect(r2.updatedPermissions).toBeUndefined();
    expect(cancelledIds()).toEqual([id2]);
    // Bash 与新规则无关，必须仍等用户确认
    await Promise.resolve();
    expect(bashSettled).toBe(false);
  });

  it("总是允许切到 bypassPermissions：连带放行队列中全部挂起请求", async () => {
    const { mgr, callback, requestIds, cancelledIds } = setup();
    const p1 = callback("Edit", { file_path: "a.ts" }, {
      suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    });
    const p2 = callback("Bash", { command: "ls" }, {});
    const [id1, id2] = requestIds();

    const outcome = mgr.resolve(id1, true, true);
    expect(outcome?.appliedMode).toBe("bypassPermissions");
    expect(((await p1) as any).behavior).toBe("allow");
    expect(((await p2) as any).behavior).toBe("allow");
    expect(cancelledIds()).toEqual([id2]);
  });

  it("带 ruleContent 的规则（按目录/前缀限定）不连带放行——匹配语义在 CLI 内部，宁可多确认一次", async () => {
    const { mgr, callback, requestIds, cancelledIds } = setup();
    const p1 = callback("Read", { file_path: "C:/proj/a.java" }, {
      suggestions: [{
        type: "addRules",
        rules: [{ toolName: "Read", ruleContent: "C:/proj/**" }],
        behavior: "allow",
        destination: "projectSettings",
      }],
    });
    let secondSettled = false;
    void callback("Read", { file_path: "D:/other/b.java" }, {}).then(() => { secondSettled = true; });

    mgr.resolve(requestIds()[0], true, true);
    expect(((await p1) as any).behavior).toBe("allow");
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(cancelledIds()).toEqual([]);
  });

  it("拒绝不触发连带放行，其余请求原样挂起", async () => {
    const { mgr, callback, requestIds } = setup();
    const p1 = callback("Read", { file_path: "a.java" }, {});
    let secondSettled = false;
    void callback("Read", { file_path: "b.java" }, {}).then(() => { secondSettled = true; });

    mgr.resolve(requestIds()[0], false);
    expect(((await p1) as any).behavior).toBe("deny");
    await Promise.resolve();
    expect(secondSettled).toBe(false);
  });
});
