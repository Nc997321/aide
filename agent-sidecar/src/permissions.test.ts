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
    mgr.resolve(id, true, { "用什么颜色？": "蓝色" });

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
    mgr.resolve(id, true);

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("denying AskUserQuestion returns deny with the default message, ignoring any stray answers", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const resultPromise = callback("AskUserQuestion", { questions: [] }, {});
    const id = (events[0] as any).id;
    mgr.resolve(id, false);

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "deny", message: "用户拒绝" });
  });

  it("deny with a user reason surfaces the reason as the SDK deny message", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const resultPromise = callback("Bash", { command: "rm -rf /tmp/cache" }, {});
    const id = (events[0] as any).id;
    mgr.resolve(id, false, undefined, "别删目录，改成只清空里层的 .tmp 文件");

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "deny", message: "别删目录，改成只清空里层的 .tmp 文件" });
  });

  it("deny without a reason still falls back to the default 用户拒绝 message", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const resultPromise = callback("Bash", { command: "ls" }, {});
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
    mgr.resolve(id, true, { "some question": "some answer" });

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });
});

describe("PermissionManager — permission_request 不再携带 SDK 专属字段", () => {
  it("permission_request 不带 alwaysAllowLabel（Aide 持久化走设置面板，不走确认弹窗）", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e))("Bash", { command: "ls" }, {});
    expect((events[0] as any).alwaysAllowLabel).toBeUndefined();
    // suggestions 也不再被解读（即便 SDK 仍传，sidecar 一律忽略）
    mgr.makeCallback((e) => events.push(e))("Edit", { file_path: "x.ts" }, {
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect((events[1] as any).alwaysAllowLabel).toBeUndefined();
  });
});

// 子代理内部工具触发权限请求时，SDK 会带 agentID——用户看到权限框弹出来时完全不知道
// 是主线程还是某个子代理在问。fromSubagent 如实反映 agentID，并借 SubagentTracker
// 翻成人看得懂的 agentName。
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

describe("PermissionManager — resolve / cancelAll（无 always / appliedMode / 连带放行）", () => {
  it("信号已中止时直接拒绝，不发 permission_request、不挂 Promise（永久悬置回归）", async () => {
    const { callback, events } = setup();
    const ac = new AbortController();
    ac.abort();
    const result = await callback("Read", { file_path: "a.ts" }, { signal: ac.signal });
    expect(result).toMatchObject({ behavior: "deny" });
    expect(events).toEqual([]);
  });

  it("普通批准：返回工具名，无 appliedMode（always 路径已移除）", async () => {
    const { mgr, callback, requestIds } = setup();
    const p = callback("Bash", { command: "ls" }, {});
    const outcome = mgr.resolve(requestIds()[0], true);
    expect(outcome).toEqual({ toolName: "Bash" });
    expect((outcome as any).appliedMode).toBeUndefined();
    expect(((await p) as any).behavior).toBe("allow");
    // allow 不再携带 updatedPermissions（SDK 持久化路径已移除）
    expect(((await p) as any).updatedPermissions).toBeUndefined();
  });

  it("拒绝只结算自身，其余请求原样挂起（无连带放行）", async () => {
    const { mgr, callback, requestIds } = setup();
    const p1 = callback("Read", { file_path: "a.java" }, {});
    let secondSettled = false;
    void callback("Read", { file_path: "b.java" }, {}).then(() => { secondSettled = true; });

    mgr.resolve(requestIds()[0], false);
    expect(((await p1) as any).behavior).toBe("deny");
    await Promise.resolve();
    expect(secondSettled).toBe(false);
  });

  it("cancelAll 撤销所有挂起请求（approved=false + permission_cancelled），interrupt 兜底", async () => {
    const { mgr, callback, requestIds, cancelledIds } = setup();
    const p1 = callback("Read", { file_path: "a.java" }, {});
    const p2 = callback("Bash", { command: "ls" }, {});
    const [id1, id2] = requestIds();

    mgr.cancelAll();

    expect(((await p1) as any).behavior).toBe("deny");
    expect(((await p2) as any).behavior).toBe("deny");
    expect(cancelledIds().sort()).toEqual([id1, id2].sort());
  });

  it("approveMatching 只放行匹配工具的挂起请求（切 acceptEdits 连带放行并排 Edit）", async () => {
    const { mgr, callback, requestIds, cancelledIds } = setup();
    const pEdit1 = callback("Edit", { file_path: "a.ts" }, {});
    const pBash = callback("Bash", { command: "ls" }, {});
    const pEdit2 = callback("Write", { file_path: "b.ts" }, {});
    let bashSettled = false;
    void pBash.then(() => { bashSettled = true; });
    const [idEdit1, , idEdit2] = requestIds();

    const settled = mgr.approveMatching(new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]));

    expect(settled).toBe(2);
    expect(((await pEdit1) as any).behavior).toBe("allow");
    expect(((await pEdit2) as any).behavior).toBe("allow");
    // 连带放行也要通知前端撤下对应弹窗（否则对话框残留）
    expect(cancelledIds().sort()).toEqual([idEdit1, idEdit2].sort());
    // 不匹配的请求原样挂起，等用户自己确认
    await Promise.resolve();
    expect(bashSettled).toBe(false);
  });
});

describe("PermissionManager — request() 直接调用（policy hook 的 ask 路径）", () => {
  it("request 返回 {approved, updatedInput}，AskUserQuestion 同样重塑 answers", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const input = { questions: [{ question: "q", options: [{ label: "a" }] }] };
    const pending = mgr.request("AskUserQuestion", input, {}, (e) => events.push(e));
    const id = (events[0] as any).id;
    mgr.resolve(id, true, { q: "a" });
    const result = await pending;
    expect(result).toEqual({ approved: true, updatedInput: { questions: input.questions, answers: { q: "a" } } });
  });

  it("request 拒绝时返回 {approved:false}，不带 updatedInput", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const pending = mgr.request("Bash", { command: "ls" }, {}, (e) => events.push(e));
    mgr.resolve((events[0] as any).id, false);
    const result = await pending;
    expect(result).toEqual({ approved: false });
    expect((result as any).updatedInput).toBeUndefined();
  });
});