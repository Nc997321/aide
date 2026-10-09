import { describe, it, expect } from "vitest";
import { PermissionManager, unansweredDenyMessage, userDenyMessage } from "./permissions.js";
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
    mgr.resolve(id, { kind: "answer", answers: { "用什么颜色？": "蓝色" } });

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
    mgr.resolve(id, { kind: "approve" });

    const result = await resultPromise;
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
  });

  it("denying AskUserQuestion returns the framed nhe-style deny (no feedback)", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const resultPromise = callback("AskUserQuestion", { questions: [] }, {});
    const id = (events[0] as any).id;
    // 问答的「跳过/拒答」= deny（skip 与 deny 是同一段引擎代码，线形状刻意不设
    // skip——那是调用方 UI 的按钮文案，见 engine/permissionResponse.ts 头注）。
    mgr.resolve(id, { kind: "deny" });

    const result = await resultPromise;
    expect(result).toEqual({
      behavior: "deny",
      decisionClassification: "user_reject",
      message: userDenyMessage(),
    });
  });

  it("deny with a user reason wraps it in the official YFe framing (never raw into the tool_result)", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const resultPromise = callback("Bash", { command: "rm -rf /tmp/cache" }, {});
    const id = (events[0] as any).id;
    mgr.resolve(id, { kind: "deny", message: "别删目录，改成只清空里层的 .tmp 文件" });

    const result = await resultPromise;
    expect(result).toEqual({
      behavior: "deny",
      decisionClassification: "user_reject",
      message: userDenyMessage("别删目录，改成只清空里层的 .tmp 文件"),
    });
    // 外框必须在：SDK 通道把 message 原样塞进 tool_result，裸理由会被读成工具输出
    expect((result as any).message).toContain("The user doesn't want to proceed");
    expect((result as any).message).toContain("别删目录，改成只清空里层的 .tmp 文件");
  });

  it("deny without a reason still carries the full official framing (STOP variant)", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const resultPromise = callback("Bash", { command: "ls" }, {});
    const id = (events[0] as any).id;
    mgr.resolve(id, { kind: "deny" });

    const result = await resultPromise;
    expect(result).toEqual({
      behavior: "deny",
      decisionClassification: "user_reject",
      message: userDenyMessage(),
    });
  });

  it("扁平形态误传 answers 给非 AskUserQuestion 工具时仍放行原 input（兼容臂保持旧行为）", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const callback = mgr.makeCallback((e) => events.push(e));

    const input = { file_path: "x.ts" };
    const resultPromise = callback("Write", input, {});
    const id = (events[0] as any).id;
    // 扁平形态（桌面/远程/ohos）不做类别校验——这是 2026-09 之前的既有行为，改动
    // 一个字节都不动；标签形态才校验（answer × 非问答会被拒，见用例「类别不匹配」）。
    mgr.resolve(id, { kind: "compat_flat", approved: true, answers: { "some question": "some answer" } });

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
      suggestions: [{ type: "setMode", mode: "auto", destination: "session" }],
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

  // 真实 id 形态：agentID 是子代理自身 id，与派发它的 tool_use_id 不同（旧测试两边
  // 都写 "a1"，掩盖了线上永远查不到名字的 bug）——映射由子代理消息的 agent_id 登记。
  it("agentID 命中 SubagentTracker 时，fromSubagent 带上真实 agentName", async () => {
    const events: ChatEvent[] = [];
    const subagents = new SubagentTracker();
    subagents.handleToolUse("toolu_01", { subagent_type: "code-reviewer", description: "审查 PR" });
    subagents.linkAgentId("a0a30b8ac5122bc5a", "toolu_01");
    const mgr = new PermissionManager();
    mgr.makeCallback((e) => events.push(e), subagents)("Bash", { command: "ls" }, { agentID: "a0a30b8ac5122bc5a" });
    expect((events[0] as any).fromSubagent).toEqual({ id: "a0a30b8ac5122bc5a", agentName: "code-reviewer" });
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
    const outcome = mgr.resolve(requestIds()[0], { kind: "approve" });
    expect(outcome).toEqual({ toolName: "Bash" });
    expect((outcome as any).appliedMode).toBeUndefined();
    expect(((await p) as any).behavior).toBe("allow");
    // allow 不再携带 updatedPermissions（SDK 持久化路径已移除）
    expect(((await p) as any).updatedPermissions).toBeUndefined();
  });

  it("未知 id 的 resolve 返回 undefined 且不广播（重复应答 / 迟到达）", () => {
    const { mgr, cancelledIds } = setup();
    expect(mgr.resolve("nope", { kind: "approve" })).toBeUndefined();
    expect(cancelledIds()).toEqual([]);
  });

  it("正常决策也广播 permission_cancelled（远程应答回灌：桌面弹窗只认事件）", async () => {
    const { mgr, callback, requestIds, cancelledIds } = setup();
    const p1 = callback("Read", { file_path: "a.java" }, {});
    const p2 = callback("Bash", { command: "ls" }, {});
    const [id1, id2] = requestIds();

    // 远程客户端（手机 / PWA）只发 permission_response 命令，桌面前端不做任何本地
    // 对账——没有这条广播，桌面弹窗永久残留，再点一次还 resolve 成 undefined。
    mgr.resolve(id1, { kind: "approve" });
    expect(cancelledIds()).toEqual([id1]);
    expect(((await p1) as any).behavior).toBe("allow");

    // 拒绝同样广播：UI 只需知道「这条请求终结了」，不区分结果
    mgr.resolve(id2, { kind: "deny", message: "不需要" });
    expect(cancelledIds().sort()).toEqual([id1, id2].sort());
    expect(((await p2) as any).behavior).toBe("deny");
  });

  it("拒绝只结算自身，其余请求原样挂起（无连带放行）", async () => {
    const { mgr, callback, requestIds } = setup();
    const p1 = callback("Read", { file_path: "a.java" }, {});
    let secondSettled = false;
    void callback("Read", { file_path: "b.java" }, {}).then(() => { secondSettled = true; });

    mgr.resolve(requestIds()[0], { kind: "deny" });
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

  it("approveMatching 只放行匹配工具的挂起请求（切 auto 连带放行并排 Edit）", async () => {
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
    mgr.resolve(id, { kind: "answer", answers: { q: "a" } });
    const result = await pending;
    expect(result).toEqual({ approved: true, updatedInput: { questions: input.questions, answers: { q: "a" } } });
  });

  it("request 拒绝时返回 {approved:false}，不带 updatedInput", async () => {
    const events: ChatEvent[] = [];
    const mgr = new PermissionManager();
    const pending = mgr.request("Bash", { command: "ls" }, {}, (e) => events.push(e));
    mgr.resolve((events[0] as any).id, { kind: "deny" });
    const result = await pending;
    expect(result).toEqual({ approved: false });
    expect((result as any).updatedInput).toBeUndefined();
  });
});

// 拒绝来源决定模型看到的外框：人工（YFe/nhe，说"用户说了什么"）vs 无人应答
// （官方「无人工审批可用」模板，自带"不要重试"）。来源由线形状的变体带进来。
describe("PermissionManager — 拒绝来源决定外框（无人应答 vs 人工）", () => {
  it("unanswered 走官方非人工外框，且不冒充用户（省略 decisionClassification）", async () => {
    const { mgr, callback, requestIds } = setup();
    const p = callback("Bash", { command: "ls" }, {});
    mgr.resolve(requestIds()[0], { kind: "unanswered", reason: "确认超时，操作未执行" });
    const result: any = await p;
    expect(result.behavior).toBe("deny");
    expect(result.message).toBe(unansweredDenyMessage("确认超时，操作未执行"));
    expect(result.message).toContain("requires interactive approval");
    expect(result.message).toContain("do not retry it in this session");
    expect(result.message).toContain("确认超时，操作未执行");
    // SDK 类型只有 user_* 三值、没有"非用户"取值 → 省略，而不是填 user_reject 撒谎
    expect(result.decisionClassification).toBeUndefined();
  });

  it("unanswered 不给理由就裸跑外框（理由归调用方，引擎不编造）", async () => {
    const { mgr, callback, requestIds } = setup();
    const p = callback("Bash", { command: "ls" }, {});
    mgr.resolve(requestIds()[0], { kind: "unanswered" });
    expect((await p) as any).toMatchObject({
      behavior: "deny",
      message: unansweredDenyMessage(),
    });
  });

  it("人工拒绝仍走 YFe 外框并带 decisionClassification（两个分支不串味）", async () => {
    const { mgr, callback, requestIds } = setup();
    const p = callback("Bash", { command: "ls" }, {});
    mgr.resolve(requestIds()[0], { kind: "deny", message: "别删" });
    const result: any = await p;
    expect(result.message).toBe(userDenyMessage("别删"));
    expect(result.decisionClassification).toBe("user_reject");
  });
});

describe("PermissionManager — 类别不匹配按拒绝 fail-closed 收尾（不静默吞、不悬死）", () => {
  it("answer 给非问答工具：工具被拒而非放行，返回判词，外框用非人工模板", async () => {
    const { mgr, callback, requestIds, cancelledIds } = setup();
    const p = callback("Bash", { command: "ls" }, {});
    const id = requestIds()[0];
    const outcome = mgr.resolve(id, { kind: "answer", answers: { q: "a" } });
    expect(outcome?.mismatch).toContain("AskUserQuestion");
    const result: any = await p;
    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("requires interactive approval");
    expect(result.decisionClassification).toBeUndefined();
    // 红线：任何终结挂起请求的路径都要广播 permission_cancelled
    expect(cancelledIds()).toEqual([id]);
  });

  it("approve 给 AskUserQuestion：同样按拒绝收尾并返回判词", async () => {
    const { mgr, callback, requestIds } = setup();
    const p = callback("AskUserQuestion", { questions: [] }, {});
    const outcome = mgr.resolve(requestIds()[0], { kind: "approve" });
    expect(outcome?.mismatch).toContain("answer");
    expect(((await p) as any).behavior).toBe("deny");
  });

  it("匹配的决策不带 mismatch（正常路径不受影响）", async () => {
    const { mgr, callback, requestIds } = setup();
    const p = callback("Bash", { command: "ls" }, {});
    const outcome = mgr.resolve(requestIds()[0], { kind: "approve" });
    expect(outcome?.mismatch).toBeUndefined();
    expect(((await p) as any).behavior).toBe("allow");
  });
});