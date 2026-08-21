import { describe, it, expect } from "vitest";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { BUILTIN_HOOKS, buildBuiltinHooks } from "./index";

// session 桩：registry 通过依赖注入的 ctx.session 调 2 个 private 方法（policy/stopEffort）。
const sessionStub = {
  makePolicyHook: (): HookCallback => async () => ({}),
  makeStopEffortHook: (): HookCallback => async () => ({}),
};

describe("builtinHooks registry", () => {
  it("policyHook 是第一条且 alwaysMounted", () => {
    const first = BUILTIN_HOOKS[0];
    expect(first.id).toBe("policy");
    expect(first.event).toBe("PreToolUse");
    expect(first.matcher).toBe(".*");
    expect(first.alwaysMounted).toBe(true);
  });

  it("顺序固定：policy → subagentModel → skillGuard(PreToolUse)，stopEffort(Stop)", () => {
    const pre = BUILTIN_HOOKS.filter((h) => h.event === "PreToolUse").map((h) => h.id);
    expect(pre).toEqual(["policy", "subagentModel", "skillGuard"]);
    const stop = BUILTIN_HOOKS.filter((h) => h.event === "Stop").map((h) => h.id);
    expect(stop).toEqual(["stopEffort"]);
  });

  it("每条有非空 purpose", () => {
    for (const h of BUILTIN_HOOKS) expect(h.purpose.length).toBeGreaterThan(0);
  });

  it("buildBuiltinHooks：policyHook 永远在 PreToolUse[0]", () => {
    const ctx = {
      cwd: "/x",
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      session: sessionStub,
    };
    const { hooks } = buildBuiltinHooks(ctx);
    expect(hooks.PreToolUse[0].matcher).toBe(".*");
  });
});
