import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { makeSubagentModelHook } from "../subagentModelDefault";
import { makeSkillGuardHook } from "../skillGuard";
import { makeCodegraphGrepNudgeHook } from "../codegraphTools";
import { makeDocxReadNudgeHook } from "../docxTools";

export interface HookBuildContext {
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  session: { makePolicyHook(cwd: string | undefined): HookCallback;
              makeImageGuardHook(): HookCallback; makeStopEffortHook(): HookCallback };
  codegraphMounted: boolean;
  docxMounted: boolean;
}

export interface BuiltinHookEntry {
  id: string;
  event: "PreToolUse" | "Stop";
  matcher: string; // Stop 用空串占位
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
  { id: "imageGuard", event: "PreToolUse", matcher: "^Read$",
    purpose: "读图保护（image input 不可用时 deny）", alwaysMounted: true,
    build: (ctx) => ctx.session.makeImageGuardHook() },
  { id: "docxRead", event: "PreToolUse", matcher: "^Read$",
    purpose: "Read 命中 .docx 时 deny 并引导 read_docx", alwaysMounted: false,
    build: (ctx) => (ctx.docxMounted ? makeDocxReadNudgeHook() : null) },
  { id: "skillGuard", event: "PreToolUse", matcher: "^Skill$",
    purpose: "子代理重型 skill 名单拦截", alwaysMounted: false,
    build: (ctx) => makeSkillGuardHook(ctx.env) },
  { id: "codegraphGrep", event: "PreToolUse", matcher: "^Grep$",
    purpose: "Grep 符号状 pattern 时注入索引工具提示", alwaysMounted: false,
    build: (ctx) => (ctx.codegraphMounted ? makeCodegraphGrepNudgeHook() : null) },
  { id: "stopEffort", event: "Stop", matcher: "",
    purpose: "读本轮 effort 盖到 message_stop", alwaysMounted: true,
    build: (ctx) => ctx.session.makeStopEffortHook() },
];

export function buildBuiltinHooks(ctx: HookBuildContext): {
  hooks: { PreToolUse: { matcher: string; hooks: HookCallback[] }[]; Stop: { hooks: HookCallback[] }[] };
  manifest: BuiltinHookManifest[];
} {
  const pre: { matcher: string; hooks: HookCallback[] }[] = [];
  const stop: { hooks: HookCallback[] }[] = [];
  const manifest: BuiltinHookManifest[] = [];
  for (const entry of BUILTIN_HOOKS) {
    const hook = entry.build(ctx);
    if (!hook) continue;
    manifest.push({ id: entry.id, event: entry.event, matcher: entry.matcher, purpose: entry.purpose });
    if (entry.event === "PreToolUse") pre.push({ matcher: entry.matcher, hooks: [hook] });
    else stop.push({ hooks: [hook] });
  }
  return { hooks: { PreToolUse: pre, Stop: stop }, manifest };
}
