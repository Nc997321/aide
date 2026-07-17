import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";

/**
 * 子代理默认模型——把 provider 配置的「子代理模型」从 env 硬覆盖改造成「未指定时兜底」。
 *
 * 背景（claude.exe 二进制实锤）：CLI 的子代理模型解析顺序是
 *   CLAUDE_CODE_SUBAGENT_MODEL (env) > Agent 工具调用的 model 参数 > AgentDefinition.model > 继承主模型
 * env 是运营级「硬钉死」：只要它非 inherit，主代理在 Agent 工具里显式指定的 model
 * （如 "dispatched (sonnet)"）会被直接短路——Aide 此前把它当「默认值」注入，属于误用。
 *
 * 本模块的修复分两半：
 *  1. cliSubagentModelEnvValue()：spawn 传给 CLI 的 env 压成 "inherit"（CLI 原生动态模式），
 *     顺带清洗从用户 shell 泄漏进 aide 进程的同名 env（cliEnv 以 process.env 为底）。
 *  2. makeSubagentModelHook()：PreToolUse hook，Agent/Task 工具输入没有 model 时把配置值
 *     折算成别名注入 updatedInput——主代理显式指定时原样放行，动态选择恢复生效。
 *
 * 为什么只能注别名：Agent 工具的 model 字段是 zod enum（sonnet/opus/haiku/fable），
 * 且 CLI 对 hook 返回的 updatedInput 会重新 safeParse（全 id 会被拒）。折算路径：
 * 值本身是别名 → 直接用；值等于某个 ANTHROPIC_DEFAULT_*_MODEL 映射值 → 用对应别名
 * （该别名经 CLI 的别名解析恰好命中配置值）。都无法命中（独立全 id）→ 退回 env 硬钉死
 * 现状——CLI 没有「全 id 兜底 + 别名优先」的通道，这是唯一无损语义。
 *
 * hook 只带 updatedInput、不带 permissionDecision——走 CLI 的 hookUpdatedInput 纯输入
 * 替换通道，不碰权限流：allowedTools 的自动批准、dontAsk/bypass 模式行为均不变。
 */

/** Agent 工具 model 字段的 zod enum 成员（claude.exe 实锤，小写）。 */
const SUBAGENT_MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;
export type SubagentModelAlias = (typeof SUBAGENT_MODEL_ALIASES)[number];

/** 折算结果：
 *  - alias：可经 hook 注入的别名（动态：显式派发优先，未指定才兜底）
 *  - raw：无法别名化的全 id——退回 env 硬钉死（行为=现状）
 *  - none：未配置/显式 inherit——不注入，未指定派发继承主模型（CLI 原生语义） */
export type SubagentModelDefault =
  | { kind: "alias"; alias: SubagentModelAlias }
  | { kind: "raw"; value: string }
  | { kind: "none" };

/** 别名 → 该别名解析目标所在的 env（provider 的 default*Model 映射注入的就是这些）。 */
const ALIAS_TARGET_ENVS: ReadonlyArray<readonly [SubagentModelAlias, string]> = [
  ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
  ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
  ["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
  ["fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"],
];

type Env = Record<string, string | undefined>;

/** 把 CLAUDE_CODE_SUBAGENT_MODEL 的配置值折算成「别名 / 全 id / 无」三态。 */
export function deriveSubagentModelDefault(env: Env): SubagentModelDefault {
  const raw = (env.CLAUDE_CODE_SUBAGENT_MODEL ?? "").trim();
  if (!raw || raw === "inherit") return { kind: "none" };
  const lowered = raw.toLowerCase();
  if ((SUBAGENT_MODEL_ALIASES as readonly string[]).includes(lowered)) {
    return { kind: "alias", alias: lowered as SubagentModelAlias };
  }
  for (const [alias, envKey] of ALIAS_TARGET_ENVS) {
    const target = (env[envKey] ?? "").trim();
    if (target && target === raw) return { kind: "alias", alias };
  }
  return { kind: "raw", value: raw };
}

/** 决定 spawn 时传给 CLI 的 CLAUDE_CODE_SUBAGENT_MODEL：可别名化/未配置压成
 *  "inherit"（放行动态 + 清洗泄漏）；无法别名化的全 id 保留原值（硬钉死现状）。 */
export function cliSubagentModelEnvValue(env: Env): string {
  const d = deriveSubagentModelDefault(env);
  return d.kind === "raw" ? d.value : "inherit";
}

/** 构造 PreToolUse hook：Agent/Task 工具输入无 model 时注入折算出的别名兜底。
 *  返回 null = 不该注册（none 无兜底可注；raw 走 env 硬钉死，hook 注入也压不过 env）。 */
export function makeSubagentModelHook(env: Env): HookCallback | null {
  const d = deriveSubagentModelDefault(env);
  if (d.kind !== "alias") return null;
  return async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = input.tool_input;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return {};
    const record = toolInput as Record<string, unknown>;
    // 主代理已显式指定（含 "inherit"）→ 尊重动态选择，不动。
    // 空串视为未指定（schema 上合法但无语义），照常兜底。
    if (typeof record.model === "string" && record.model) return {};
    // updatedInput 必须是完整工具输入——CLI 会拿它单独 safeParse（缺必填字段会被拒），
    // 不能只发增量 { model }。
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        updatedInput: { ...record, model: d.alias },
      },
    };
  };
}
