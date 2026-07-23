import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";

/**
 * 子代理重型 skill 守卫——通用机制，非 claude-api 专属补丁。
 *
 * 根因：重型 skill（带激进 TRIGGER、body 几万~十几万 token）在嵌套子代理 fan-out
 * 里自动触发时，会被「子代理数量 × 每个代理内部轮数」放大并逐轮重发，撑爆累计 input
 * （实测一次 10 轮对话达 25M，其中 18 个子代理各注入 claude-api 的 139K token 文档）。
 * claude-api 只是当前实例，未来任何带激进 TRIGGER 的大 skill 都会重演——所以这里做成
 * 名单机制，claude-api 是名单第一项种子。
 *
 * 策略：只在**子代理上下文**（`agent_id` 非空）拦截名单内 skill；**主会话放行**——
 * 主会话显式加载一次重型 skill 是可接受的（一次 139K，不是 fan-out 的 18×139K），
 * 爆炸的是 fan-out 里的 N×。这样既止血又保留主会话可用性。
 *
 * 配置（operator 级 env；UI 设置项为未来增强）：
 *  - `AIDE_HEAVY_SKILLS`：逗号分隔，覆盖默认名单。
 *  - `AIDE_SUBAGENT_HEAVY_SKILL_GUARD`：`off|0|false` 关闭守卫（默认 on）。
 *
 * 实现先例：`subagentModelDefault.ts` 的 `makeSubagentModelHook`（同款 PreToolUse hook
 * 代码注册模式）。返回 null = 不注册。
 */

/** 默认重型 skill 名单——单一配置点，扩展只改这里或用 env 覆盖，不散落 if。 */
const HEAVY_SKILLS_DEFAULT = ["claude-api"];

type Env = Record<string, string | undefined>;

/** 解析生效的重型 skill 名单（小写比对，防大小写漂移）。空数组 = 名单空，守卫形同关闭。 */
export function resolveHeavySkills(env: Env): string[] {
  const raw = (env.AIDE_HEAVY_SKILLS ?? "").trim();
  if (!raw) return HEAVY_SKILLS_DEFAULT;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 守卫是否启用（默认 on；显式 off/0/false 关闭）。 */
export function skillGuardEnabled(env: Env): boolean {
  const v = (env.AIDE_SUBAGENT_HEAVY_SKILL_GUARD ?? "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

/** 构造 PreToolUse hook：子代理上下文里 Skill 调用命中重型名单则 deny，主会话放行。
 *  返回 null = 守卫关闭或名单空，不该注册。 */
export function makeSkillGuardHook(env: Env): HookCallback | null {
  if (!skillGuardEnabled(env)) return null;
  const heavy = resolveHeavySkills(env);
  if (heavy.length === 0) return null;
  const heavySet = new Set(heavy);
  return async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    // agent_id 非空 = 子代理上下文（SDK BaseHookInput 注释：仅子代理内 fire 时 present，
    // 主线程 absent）。用 agent_id（非 agent_type）区分主/子。
    const agentId = (input as any).agent_id as string | undefined;
    if (!agentId) return {}; // 主会话放行
    const toolInput = input.tool_input;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return {};
    const record = toolInput as Record<string, unknown>;
    const skill = typeof record.skill === "string" ? record.skill.trim().toLowerCase() : "";
    if (!skill || !heavySet.has(skill)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `子代理内禁用重型 skill "${record.skill}"：其 body 过大（可达十余万 token），在 fan-out 里会被子代理数 × 内部轮数放大并逐轮重发，撑爆累计 input。需要时请在主会话显式加载，或改为按需 Read 对应语言文档。`,
      },
    };
  };
}