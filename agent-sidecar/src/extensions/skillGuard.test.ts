import { describe, it, expect } from "vitest";
import { makeSkillGuardHook, resolveHeavySkills, skillGuardEnabled } from "./skillGuard.js";

function preSkillInput(skill: string, agentId?: string) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: "Skill",
    tool_use_id: "tu1",
    tool_input: { skill },
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

describe("skillGuard 配置解析", () => {
  it("默认名单是 [claude-api]", () => {
    expect(resolveHeavySkills({})).toEqual(["claude-api"]);
  });
  it("AIDE_HEAVY_SKILLS 覆盖名单（小写化、去空白）", () => {
    expect(resolveHeavySkills({ AIDE_HEAVY_SKILLS: " Foo , Bar " })).toEqual(["foo", "bar"]);
  });
  it("AIDE_HEAVY_SKILLS 全空白过滤后为空数组", () => {
    expect(resolveHeavySkills({ AIDE_HEAVY_SKILLS: " , " })).toEqual([]);
  });
  it("开关默认 on；off/0/false 关闭", () => {
    expect(skillGuardEnabled({})).toBe(true);
    expect(skillGuardEnabled({ AIDE_SUBAGENT_HEAVY_SKILL_GUARD: "off" })).toBe(false);
    expect(skillGuardEnabled({ AIDE_SUBAGENT_HEAVY_SKILL_GUARD: "0" })).toBe(false);
    expect(skillGuardEnabled({ AIDE_SUBAGENT_HEAVY_SKILL_GUARD: "false" })).toBe(false);
  });
});

describe("makeSkillGuardHook 注册门槛", () => {
  it("开关关闭 → 返回 null 不注册", () => {
    expect(makeSkillGuardHook({ AIDE_SUBAGENT_HEAVY_SKILL_GUARD: "off" })).toBeNull();
  });
  it("名单空 → 返回 null 不注册", () => {
    expect(makeSkillGuardHook({ AIDE_HEAVY_SKILLS: " , " })).toBeNull();
  });
  it("默认配置 → 返回 hook", () => {
    expect(makeSkillGuardHook({})).not.toBeNull();
  });
});

describe("skillGuard hook 行为", () => {
  const hook = makeSkillGuardHook({})!;

  it("子代理上下文调用 claude-api → deny", async () => {
    const out = await hook(preSkillInput("claude-api", "agent-xyz") as any, "tu1", { signal: new AbortController().signal } as any);
    expect(out).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
    expect((out as any).hookSpecificOutput.permissionDecisionReason).toContain("claude-api");
  });

  it("主会话（无 agent_id）调用 claude-api → 放行", async () => {
    const out = await hook(preSkillInput("claude-api") as any, "tu1", { signal: new AbortController().signal } as any);
    expect(out).toEqual({});
  });

  it("子代理调用非名单 skill → 放行", async () => {
    const out = await hook(preSkillInput("some-small-skill", "agent-xyz") as any, "tu1", { signal: new AbortController().signal } as any);
    expect(out).toEqual({});
  });

  it("skill 名大小写不敏感——Claude-API 也拦", async () => {
    const out = await hook(preSkillInput("Claude-API", "agent-xyz") as any, "tu1", { signal: new AbortController().signal } as any);
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("AIDE_HEAVY_SKILLS 覆盖后拦自定义 skill", async () => {
    const h = makeSkillGuardHook({ AIDE_HEAVY_SKILLS: "my-heavy-skill" })!;
    const deny = await h(preSkillInput("my-heavy-skill", "a1") as any, "tu1", { signal: new AbortController().signal } as any);
    expect(deny).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const pass = await h(preSkillInput("claude-api", "a1") as any, "tu1", { signal: new AbortController().signal } as any);
    expect(pass).toEqual({});
  });

  it("非 PreToolUse 事件 → 放行（防御性，matcher 已限 ^Skill$）", async () => {
    const out = await hook({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_use_id: "tu1", tool_input: { skill: "claude-api" }, agent_id: "a1" } as any, "tu1", { signal: new AbortController().signal } as any);
    expect(out).toEqual({});
  });
});