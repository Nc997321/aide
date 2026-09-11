// SessionPolicy 直测（拆分批 2 后策略状态可独立于 worker 测试）。
// evaluatePolicy 用真实现（同目录纯函数）；支线状态经 branchState 桩注入。
import { describe, it, expect, vi } from "vitest";
import { SessionPolicy, type PolicyBranchState } from "./sessionHook.js";
import type { PermissionRule } from "./types.js";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

function branchState(over: Partial<PolicyBranchState> = {}): PolicyBranchState {
  return {
    btwMode: false,
    lightweightMode: false,
    taskTools: undefined,
    automationConfig: undefined,
    cwd: "/proj",
    ...over,
  };
}

function rule(effect: "allow" | "deny" | "ask", tool: string, scope: "user" | "session" = "user", order = 0): PermissionRule {
  return {
    id: `${scope}-${tool}-${effect}`,
    scope,
    order,
    effect,
    tool,
    matcher: { kind: "tool" },
    source: { label: scope, readOnly: scope === "user" },
  };
}

function makePolicy(state: Partial<PolicyBranchState> = {}, verdict: "allow" | "deny" | "defer" = "defer") {
  const automationVerdict = vi.fn(() => verdict);
  const policy = new SessionPolicy({
    branchState: () => branchState(state),
    automationVerdict,
  });
  return { policy, automationVerdict };
}

function preToolUse(tool: string): HookInput {
  return { hook_event_name: "PreToolUse", tool_name: tool, tool_input: {} } as unknown as HookInput;
}

type HookOut = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

describe("SessionPolicy.applySnapshot", () => {
  it("revision 单调：旧快照被忽略（无回滚）", async () => {
    const { policy } = makePolicy();
    policy.applySnapshot({ revision: 2, rules: [rule("deny", "Bash")] });
    policy.applySnapshot({ revision: 1, rules: [] }); // stale
    const out = await policy.makeHook("/proj")(preToolUse("Bash"), undefined, { signal: new AbortController().signal }) as HookOut;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny"); // revision 2 仍生效
  });
});

describe("SessionPolicy.makeHook 支线分支", () => {
  it("轻量 btw：一切工具 deny（纯问答语义）", async () => {
    const { policy } = makePolicy({ lightweightMode: true });
    const out = await policy.makeHook("/proj")(preToolUse("Read"), undefined, { signal: new AbortController().signal }) as HookOut;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("automation：verdict allow/deny 直返，defer 回 {}；白名单提示带连接器清单", async () => {
    const cfg = { taskId: "t", runId: "r", preset: "auto" as const, tools: ["*"], mcpAllowlist: ["conn-a"], taskDir: "", sessionDir: "" };
    for (const [verdict, expected] of [["allow", "allow"], ["deny", "deny"], ["defer", undefined]] as const) {
      const { policy } = makePolicy({ automationConfig: cfg }, verdict);
      const out = await policy.makeHook("/proj")(preToolUse("Bash"), undefined, { signal: new AbortController().signal }) as HookOut;
      expect(out.hookSpecificOutput?.permissionDecision).toBe(expected);
      if (verdict === "deny") expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("conn-a");
    }
  });

  it("btw 任务支线：无匹配规则时 deny（defer 会被 CLI 静默放行 = 支线开 bypass）", async () => {
    const { policy } = makePolicy({ taskTools: ["Bash"] });
    const out = await policy.makeHook("/proj")(preToolUse("Read"), undefined, { signal: new AbortController().signal }) as HookOut;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("automation deny + 空白名单 → 提示「无」；hook 无 cwd / 无 tool_input 走兜底臂", async () => {
    const cfg = { taskId: "t", runId: "r", preset: "auto" as const, tools: ["*"], mcpAllowlist: [], taskDir: "", sessionDir: "" };
    const { policy } = makePolicy({ automationConfig: cfg }, "deny");
    const out = await policy.makeHook("/proj")(preToolUse("Bash"), undefined, { signal: new AbortController().signal }) as HookOut;
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("无");

    // makeHook(undefined)：evaluate 的 cwd 走 state.cwd 兜底；tool_input 缺席走 {} 兜底
    const { policy: p2 } = makePolicy();
    p2.applySnapshot({ revision: 1, rules: [rule("ask", "Bash")] });
    const out2 = await p2.makeHook(undefined)(
      { hook_event_name: "PreToolUse", tool_name: "Bash" } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    ) as HookOut;
    expect(out2.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  it("btw 支线 ask → deny（无人应答权限弹窗，不挂起）", async () => {
    const { policy } = makePolicy({ btwMode: true });
    policy.applySnapshot({ revision: 1, rules: [rule("ask", "Bash")] });
    const out = await policy.makeHook("/proj")(preToolUse("Bash"), undefined, { signal: new AbortController().signal }) as HookOut;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("SessionPolicy.makeHook 主会话分支", () => {
  const opts = { signal: new AbortController().signal };

  it("ask 规则 → permissionDecision ask（交还 CLI 转 canUseTool 弹窗）", async () => {
    const { policy } = makePolicy();
    policy.applySnapshot({ revision: 1, rules: [rule("ask", "Bash")] });
    const out = await policy.makeHook("/proj")(preToolUse("Bash"), undefined, opts) as HookOut;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("ask");
  });

  it("无匹配规则 → {}（绝不 defer——CLI 不认会断工具执行）", async () => {
    const { policy } = makePolicy();
    const out = await policy.makeHook("/proj")(preToolUse("Bash"), undefined, opts) as HookOut;
    expect(out).toEqual({});
  });

  it("非 PreToolUse 事件 / 无 tool_name → {} 早退", async () => {
    const { policy } = makePolicy();
    const stop = await policy.makeHook("/proj")({ hook_event_name: "Stop" } as unknown as HookInput, undefined, opts) as HookOut;
    expect(stop).toEqual({});
    const noTool = await policy.makeHook("/proj")({ hook_event_name: "PreToolUse" } as unknown as HookInput, undefined, opts) as HookOut;
    expect(noTool).toEqual({});
  });

  it("会话级 allow 压过快照 ask（SCOPE_PRIORITY：session 在 user 前）", async () => {
    const { policy } = makePolicy();
    policy.applySnapshot({ revision: 1, rules: [rule("ask", "Edit")] });
    policy.addSessionRules([{ effect: "allow", tool: "Edit", matcher: { kind: "tool" } }]);
    const out = await policy.makeHook("/proj")(preToolUse("Edit"), undefined, opts) as HookOut;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");
  });

  it("deny 绝对性：快照 deny 一票否决会话级 allow（evaluate.ts 安全语义，任何作用域）", async () => {
    const { policy } = makePolicy();
    policy.applySnapshot({ revision: 1, rules: [rule("deny", "Edit")] });
    policy.addSessionRules([{ effect: "allow", tool: "Edit", matcher: { kind: "tool" } }]);
    const out = await policy.makeHook("/proj")(preToolUse("Edit"), undefined, opts) as HookOut;
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("SessionPolicy.addSessionRules", () => {
  it("只收 allow；文件工具家族展开；重复入库去重", () => {
    const { policy } = makePolicy();
    const draft = { effect: "allow" as const, tool: "Write", matcher: { kind: "path" as const, field: "file_path" as const, file: "/a/b.txt" } };
    policy.addSessionRules([draft, { effect: "deny", tool: "Bash", matcher: { kind: "tool" } }]);
    expect(policy.ruleCount).toBe(3); // Write→Edit/Write/MultiEdit 家族展开；deny 草稿被拒
    policy.addSessionRules([draft]); // 同 (tool,matcher) 再来
    expect(policy.ruleCount).toBe(3); // 去重不堆积
  });

  it("NotebookEdit 不在文件家族（输入字段是 notebook_path）", () => {
    const { policy } = makePolicy();
    policy.addSessionRules([{ effect: "allow", tool: "NotebookEdit", matcher: { kind: "path", field: "notebook_path", file: "/a.ipynb" } }]);
    expect(policy.ruleCount).toBe(1);
  });
});
