import { describe, it, expect } from "vitest";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { makeModelSwitchGuard } from "../../engine/modelSwitchGuard";
import { BUILTIN_HOOKS, buildBuiltinHooks } from "./index";
import type { ChatEvent } from "../../engine/types.js";
import { KbScopeStore } from "../knowledge/scope";

// session 桩：registry 通过依赖注入的 ctx.session 调 private 方法（policy/stopEffort/
// modelSwitchGuard）。guard 返回 null（支线场景）→ 两个 switch hook 不挂载。
const sessionStub = {
  makePolicyHook: (): HookCallback => async () => ({}),
  makeStopEffortHook: (): HookCallback => async () => ({}),
  makeModelSwitchGuard: () => null,
  metadata: () => ({}),
};

describe("builtinHooks registry", () => {
  it("policyHook 是第一条且 alwaysMounted", () => {
    const first = BUILTIN_HOOKS[0];
    expect(first.id).toBe("policy");
    expect(first.event).toBe("PreToolUse");
    expect(first.matcher).toBe(".*");
    expect(first.alwaysMounted).toBe(true);
  });

  it("顺序固定：policy → subagentModel → skillGuard → kbMemoryGuard(PreToolUse)，stopEffort(Stop)，switchGuard 一对", () => {
    const pre = BUILTIN_HOOKS.filter((h) => h.event === "PreToolUse").map((h) => h.id);
    expect(pre).toEqual(["policy", "subagentModel", "skillGuard", "kbMemoryGuard"]);
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

  it("guard=null（支线场景）→ PreModelSwitch/PostModelSwitch 两键缺席且不入 manifest", () => {
    const ctx = {
      cwd: "/x",
      env: {},
      session: sessionStub,
    };
    const { hooks, manifest } = buildBuiltinHooks(ctx);
    expect(hooks.PreModelSwitch).toBeUndefined();
    expect(hooks.PostModelSwitch).toBeUndefined();
    expect(manifest.some((m) => m.id === "modelSwitchGuard" || m.id === "modelSwitchCommitted")).toBe(false);
  });

  it("guard 非空 → 两 hook 分组挂载 + manifest 登记（switchGuard 一对）", () => {
    const guard = makeModelSwitchGuard({
      emit: (_e: ChatEvent) => {},
      onCommitted: () => {},
      consumeUserSwitchIntent: () => true,
    });
    const ctx = {
      cwd: "/x",
      env: {},
      session: {
        ...sessionStub,
        makeModelSwitchGuard: () => guard,
      },
    };
    const { hooks, manifest } = buildBuiltinHooks(ctx);
    expect(hooks.PreModelSwitch).toHaveLength(1);
    expect(hooks.PostModelSwitch).toHaveLength(1);
    expect(manifest.some((m) => m.id === "modelSwitchGuard" && m.event === "PreModelSwitch")).toBe(true);
    expect(manifest.some((m) => m.id === "modelSwitchCommitted" && m.event === "PostModelSwitch")).toBe(true);
  });

  it("kbMemoryGuard 只在有圈选登记簿时挂载（条件挂）", () => {
    const base = { cwd: "/x", env: { CLAUDE_CONFIG_DIR: "/home/u/.aide/claude" }, session: sessionStub };
    expect(buildBuiltinHooks(base).manifest.some((m) => m.id === "kbMemoryGuard")).toBe(false);
    const withScopes = { ...base, kbScopes: new KbScopeStore() };
    expect(buildBuiltinHooks(withScopes).manifest.some((m) => m.id === "kbMemoryGuard")).toBe(true);
  });
});
