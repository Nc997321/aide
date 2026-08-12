import { describe, it, expect } from "vitest";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { BUILTIN_HOOKS, buildBuiltinHooks } from "./index";

// session 桩：registry 通过依赖注入的 ctx.session 调 3 个 private 方法（policy/imageGuard/stopEffort）。
const sessionStub = {
  makePolicyHook: (): HookCallback => async () => ({}),
  makeImageGuardHook: (): HookCallback => async () => ({}),
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

  it("顺序固定：policy → subagentModel → imageGuard → skillGuard → codegraphGrep(PreToolUse)，stopEffort(Stop)", () => {
    const pre = BUILTIN_HOOKS.filter((h) => h.event === "PreToolUse").map((h) => h.id);
    expect(pre).toEqual(["policy", "subagentModel", "imageGuard", "skillGuard", "codegraphGrep"]);
    const stop = BUILTIN_HOOKS.filter((h) => h.event === "Stop").map((h) => h.id);
    expect(stop).toEqual(["stopEffort"]);
  });

  it("每条有非空 purpose", () => {
    for (const h of BUILTIN_HOOKS) expect(h.purpose.length).toBeGreaterThan(0);
  });

  it("buildBuiltinHooks：codegraphMounted=false 时 codegraphGrep 不进 manifest 也不进 hooks", () => {
    const ctx = {
      cwd: "/x",
      // brief 原 env:{} 下 makeSubagentModelHook 返回 null（无 CLAUDE_CODE_SUBAGENT_MODEL），
      // 断言 4 会挂——补可别名化的 env 让 subagentModel 兜底挂载，断言值不变。
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      session: sessionStub,
      codegraphMounted: false,
    };
    const { hooks, manifest } = buildBuiltinHooks(ctx);
    expect(hooks.PreToolUse.length).toBe(4); // policy + subagentModel + imageGuard + skillGuard（codegraph 不挂）
    expect(manifest.find((m) => m.id === "codegraphGrep")).toBeUndefined();
  });

  it("buildBuiltinHooks：policyHook 永远在 PreToolUse[0]", () => {
    const ctx = {
      cwd: "/x",
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" },
      session: sessionStub,
      codegraphMounted: true,
    };
    const { hooks } = buildBuiltinHooks(ctx);
    expect(hooks.PreToolUse[0].matcher).toBe(".*");
  });
});
