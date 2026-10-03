import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { makeSubagentModelHook } from "../../engine/subagentModelDefault";
import { makeSkillGuardHook } from "../skillGuard";
import { makeMemoryEventsHook } from "./memoryEvents";
import { makeKbMemoryGuardHook } from "../knowledge/memoryGuard";
import type { KbScopeStore } from "../knowledge/scope";
import { makeLspGlanceHook } from "../lspGlance";
import { isLspWarm, queryLsp } from "../lspClient";
import type { ChatEvent } from "../../engine/types.js";
import type { ModelSwitchGuard } from "../../engine/modelSwitchGuard";

export interface HookBuildContext {
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  session: { makePolicyHook(cwd: string | undefined): HookCallback;
              makeStopEffortHook(): HookCallback;
              makeModelSwitchGuard(): ModelSwitchGuard | null };
  /** aide-lsp 通道（闸门已算好，见 lspGate.ts）。缺省 = 不挂 grep 顺带作答。 */
  lsp?: { mounted: boolean; emit: (e: ChatEvent) => void };
  /** 本会话的圈选登记簿：本轮带圈选期间，memoryGuard 拒绝写记忆。缺省 = 不挂。 */
  kbScopes?: KbScopeStore;
}

export interface BuiltinHookEntry {
  id: string;
  event: "PreToolUse" | "PostToolUse" | "Stop" | "PreModelSwitch" | "PostModelSwitch";
  matcher: string; // 非 PreToolUse/PostToolUse 用空串占位
  purpose: string;
  alwaysMounted: boolean;
  build: (ctx: HookBuildContext) => HookCallback | null;
}

export interface BuiltinHookManifest {
  id: string; event: string; matcher: string; purpose: string;
}

export const BUILTIN_HOOKS: BuiltinHookEntry[] = [
  { id: "policy", event: "PreToolUse", matcher: ".*",
    purpose: "工具权限门控（权威前置层，不可越过）", alwaysMounted: true,
    build: (ctx) => ctx.session.makePolicyHook(ctx.cwd) },
  { id: "subagentModel", event: "PreToolUse", matcher: "^(Agent|Task)$",
    purpose: "子代理模型选择兜底", alwaysMounted: false,
    build: (ctx) => makeSubagentModelHook(ctx.env) },
  { id: "skillGuard", event: "PreToolUse", matcher: "^Skill$",
    purpose: "子代理重型 skill 名单拦截", alwaysMounted: false,
    build: (ctx) => makeSkillGuardHook(ctx.env) },
  { id: "kbMemoryGuard", event: "PreToolUse", matcher: "^(Write|Edit|MultiEdit|NotebookEdit)$",
    purpose: "知识库圈选改写那一轮不写记忆（拦 Write/Edit 落在 memory 目录；本轮用户消息不带圈选即恢复）", alwaysMounted: false,
    build: (ctx) => makeKbMemoryGuardHook({ configDir: ctx.env.CLAUDE_CONFIG_DIR ?? "", scopes: ctx.kbScopes }) },
  { id: "memoryEvents", event: "PostToolUse", matcher: "^(Read|Write|Edit|MultiEdit)$",
    purpose: "记忆观测台事件台账（memory 目录读写埋点，只记录不干预）", alwaysMounted: true,
    build: (ctx) => makeMemoryEventsHook(ctx.env, ctx.cwd) },
  { id: "lspGlance", event: "PostToolUse", matcher: "^(Grep|Bash)$",
    purpose: "grep 顺带作答：搜代码标识符时附上语言服务器的定义位置与真实引用数（语言服务器热了才附，不改工具结果）", alwaysMounted: false,
    build: (ctx) => {
      if (!ctx.lsp?.mounted || !ctx.cwd) return null;
      const { emit } = ctx.lsp;
      const cwd = ctx.cwd;
      return makeLspGlanceHook({
        cwd,
        isWarm: () => isLspWarm(cwd),
        query: (tool, args, timeoutMs) => queryLsp(tool, args, cwd, emit, { timeoutMs }),
      });
    } },
  { id: "stopEffort", event: "Stop", matcher: "",
    purpose: "读本轮 effort 盖到 message_stop", alwaysMounted: true,
    build: (ctx) => ctx.session.makeStopEffortHook() },
  { id: "modelSwitchGuard", event: "PreModelSwitch", matcher: "",
    purpose: "模型切换成本确认（缓存热+大体量才问，SDK 真相裁决）", alwaysMounted: false,
    build: (ctx) => ctx.session.makeModelSwitchGuard()?.preSwitchHook ?? null },
  { id: "modelSwitchCommitted", event: "PostModelSwitch", matcher: "",
    purpose: "模型切换坐实上报（前端落盘依据）", alwaysMounted: false,
    build: (ctx) => ctx.session.makeModelSwitchGuard()?.postSwitchHook ?? null },
];

export function buildBuiltinHooks(ctx: HookBuildContext): {
  hooks: {
    PreToolUse: { matcher: string; hooks: HookCallback[] }[];
    PostToolUse?: { matcher: string; hooks: HookCallback[] }[];
    Stop: { hooks: HookCallback[] }[];
    PreModelSwitch?: { hooks: HookCallback[] }[];
    PostModelSwitch?: { hooks: HookCallback[] }[];
  };
  manifest: BuiltinHookManifest[];
} {
  const pre: { matcher: string; hooks: HookCallback[] }[] = [];
  const post: { matcher: string; hooks: HookCallback[] }[] = [];
  const stop: { hooks: HookCallback[] }[] = [];
  const preSwitch: { hooks: HookCallback[] }[] = [];
  const postSwitch: { hooks: HookCallback[] }[] = [];
  const manifest: BuiltinHookManifest[] = [];
  for (const entry of BUILTIN_HOOKS) {
    const hook = entry.build(ctx);
    if (!hook) continue;
    manifest.push({ id: entry.id, event: entry.event, matcher: entry.matcher, purpose: entry.purpose });
    if (entry.event === "PreToolUse") pre.push({ matcher: entry.matcher, hooks: [hook] });
    else if (entry.event === "PostToolUse") post.push({ matcher: entry.matcher, hooks: [hook] });
    else if (entry.event === "Stop") stop.push({ hooks: [hook] });
    else if (entry.event === "PreModelSwitch") preSwitch.push({ hooks: [hook] });
    else postSwitch.push({ hooks: [hook] });
  }
  return {
    hooks: {
      PreToolUse: pre,
      ...(post.length ? { PostToolUse: post } : {}),
      Stop: stop,
      ...(preSwitch.length ? { PreModelSwitch: preSwitch } : {}),
      ...(postSwitch.length ? { PostModelSwitch: postSwitch } : {}),
    },
    manifest,
  };
}
