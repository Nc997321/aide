import { describe, expect, it } from "vitest";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  cliSubagentModelEnvValue,
  deriveSubagentModelDefault,
  makeSubagentModelHook,
} from "./subagentModelDefault.js";

type Env = Record<string, string | undefined>;

/** 模拟用户的真实 KIMI 配置：subagent == defaultHaikuModel（全 id 一致）。 */
const KIMI_ENV: Env = {
  CLAUDE_CODE_SUBAGENT_MODEL: "kimi-for-coding",
  ANTHROPIC_MODEL: "kimi-for-coding-highspeed",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-for-coding-highspeed",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-for-coding",
};

function toolInput(input: unknown): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: input,
    tool_use_id: "tu_1",
  } as PreToolUseHookInput;
}

async function callHook(env: Env, input: unknown) {
  const hook = makeSubagentModelHook(env);
  if (!hook) throw new Error("hook should exist for this env");
  return hook(toolInput(input), undefined, { signal: new AbortController().signal });
}

describe("deriveSubagentModelDefault", () => {
  it("未配置（缺失/空串）→ none：不注入，未指定派发继承主模型", () => {
    expect(deriveSubagentModelDefault({})).toEqual({ kind: "none" });
    expect(deriveSubagentModelDefault({ CLAUDE_CODE_SUBAGENT_MODEL: "" })).toEqual({ kind: "none" });
    expect(deriveSubagentModelDefault({ CLAUDE_CODE_SUBAGENT_MODEL: "  " })).toEqual({ kind: "none" });
  });

  it("显式 inherit → none（CLI 原生语义）", () => {
    expect(deriveSubagentModelDefault({ CLAUDE_CODE_SUBAGENT_MODEL: "inherit" })).toEqual({ kind: "none" });
  });

  it("直接填别名 → alias（大小写宽容，CLI enum 是小写）", () => {
    expect(deriveSubagentModelDefault({ CLAUDE_CODE_SUBAGENT_MODEL: "haiku" })).toEqual({
      kind: "alias",
      alias: "haiku",
    });
    expect(deriveSubagentModelDefault({ CLAUDE_CODE_SUBAGENT_MODEL: "Sonnet" })).toEqual({
      kind: "alias",
      alias: "sonnet",
    });
    expect(deriveSubagentModelDefault({ CLAUDE_CODE_SUBAGENT_MODEL: "fable" })).toEqual({
      kind: "alias",
      alias: "fable",
    });
  });

  it("全 id 命中某个 default*Model 映射 → 折算成对应别名（用户四个真实配置的形态）", () => {
    expect(deriveSubagentModelDefault(KIMI_ENV)).toEqual({ kind: "alias", alias: "haiku" });
    expect(
      deriveSubagentModelDefault({
        CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
      }),
    ).toEqual({ kind: "alias", alias: "haiku" });
    expect(
      deriveSubagentModelDefault({
        CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.2",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2",
      }),
    ).toEqual({ kind: "alias", alias: "sonnet" });
    expect(
      deriveSubagentModelDefault({
        CLAUDE_CODE_SUBAGENT_MODEL: "k3[1m]",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "k3[1m]",
      }),
    ).toEqual({ kind: "alias", alias: "opus" });
  });

  it("全 id 不等于任何映射值（含映射全空）→ raw：退回 env 硬钉死现状", () => {
    expect(
      deriveSubagentModelDefault({
        CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "another-model",
      }),
    ).toEqual({ kind: "raw", value: "deepseek-v4-flash" });
    expect(
      deriveSubagentModelDefault({ CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash" }),
    ).toEqual({ kind: "raw", value: "deepseek-v4-flash" });
  });

  it("映射值为空串不参与匹配（空 target 不能\"等于\"配置值）", () => {
    expect(
      deriveSubagentModelDefault({
        CLAUDE_CODE_SUBAGENT_MODEL: "x",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "",
      }),
    ).toEqual({ kind: "raw", value: "x" });
  });
});

describe("cliSubagentModelEnvValue", () => {
  it("可别名化/未配置 → \"inherit\"：压掉硬覆盖放行动态，同时清洗父进程泄漏", () => {
    expect(cliSubagentModelEnvValue(KIMI_ENV)).toBe("inherit");
    expect(cliSubagentModelEnvValue({})).toBe("inherit");
  });

  it("无法别名化的全 id → 保留原值（CLI 没有\"全 id 兜底+别名优先\"的通道）", () => {
    expect(cliSubagentModelEnvValue({ CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash" })).toBe(
      "deepseek-v4-flash",
    );
  });
});

describe("makeSubagentModelHook", () => {
  it("none/raw 时不注册 hook（null）：raw 走 env 硬钉死，none 无需兜底", () => {
    expect(makeSubagentModelHook({})).toBeNull();
    expect(makeSubagentModelHook({ CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash" })).toBeNull();
    expect(makeSubagentModelHook(KIMI_ENV)).toBeTypeOf("function");
  });

  it("工具输入无 model → 注入折算出的别名，其余字段原样保留", async () => {
    const out = await callHook(KIMI_ENV, {
      description: "调研 XXX",
      prompt: "看看这个仓库",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          description: "调研 XXX",
          prompt: "看看这个仓库",
          subagent_type: "general-purpose",
          run_in_background: true,
          model: "haiku",
        },
      },
    });
  });

  it("主代理显式指定了 model（含 \"inherit\"）→ 不动，返回 {}（动态选择优先）", async () => {
    expect(await callHook(KIMI_ENV, { description: "d", prompt: "p", model: "sonnet" })).toEqual({});
    expect(await callHook(KIMI_ENV, { description: "d", prompt: "p", model: "inherit" })).toEqual({});
  });

  it("model 为空串 → 视为未指定，照常注入", async () => {
    const out = await callHook(KIMI_ENV, { description: "d", prompt: "p", model: "" });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { description: "d", prompt: "p", model: "haiku" },
      },
    });
  });

  it("防御：非 PreToolUse 事件 / 非对象 tool_input → {}", async () => {
    const hook = makeSubagentModelHook(KIMI_ENV)!;
    const notPre = {
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { prompt: "p" },
      tool_response: {},
      tool_use_id: "tu_1",
    };
    expect(
      await hook(notPre as never, undefined, { signal: new AbortController().signal }),
    ).toEqual({});
    expect(await callHook(KIMI_ENV, "not-an-object")).toEqual({});
    expect(await callHook(KIMI_ENV, null)).toEqual({});
  });
});
