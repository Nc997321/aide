// 冒烟：会话中「快速(low)=关思考」是否生效——thinking 参数的会话中开关通道验证。
// 背景：thinking 只在 query 创建时固定；会话中切 effort 走 applyFlagSettings({effortLevel})，
// 只改 effort 不改 thinking → 用户切「快速」后思考块仍出现。候选通道：
//   Settings.alwaysThinkingEnabled: false = 关思考（SDK 类型注释原文）
// 本脚本实测两个关键问题：
//   Q1: spawn 时显式 thinking:{adaptive} 的 query，applyFlagSettings({effortLevel:'low',
//       alwaysThinkingEnabled:false}) 能否把思考关掉？（显式 option 会不会压过 setting）
//   Q2: spawn 不带 thinking option（默认 adaptive）时，同上 flag 是否关思考；
//       再切回 high + alwaysThinkingEnabled:true 是否恢复思考。
// 用法（agent-sidecar 目录）：npx tsx smoke-thinking.ts [option|settings]
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
const DEFAULT_CLAUDE_EXE = process.env.USERPROFILE + "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const claudeExe = process.env.AIDE_CLAUDE_EXE ?? (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);
const env: Record<string, string | undefined> = {
  ...process.env,
  CLAUDE_CONFIG_DIR: process.env.USERPROFILE + "/.aide/claude",
  ANTHROPIC_BASE_URL: "http://localhost:11434",
};
delete env.CLAUDE_CODE_EFFORT_LEVEL;

const THINK_PROMPT = "估算 127*349 的精确值。先仔细心算验证两遍再回答，只输出最终数字。";
const mode = process.argv[2] ?? "option";

const pending: any[] = [];
let wake: (() => void) | null = null;
async function* prompts() {
  while (true) {
    if (pending.length) { yield pending.shift(); continue; }
    await new Promise<void>((r) => { wake = r; });
  }
}
function push(text: string) {
  pending.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  wake?.();
}

const stopHook = async (input: any) => { console.log("STOP_HOOK effort =", JSON.stringify(input.effort)); return {}; };

const options: any = {
  model: "glm-5.2:cloud",
  settingSources: [],
  allowedTools: [],
  hooks: { Stop: [{ hooks: [stopHook] }] },
  effort: "high" as const,
  env,
  ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
};
if (mode === "option") {
  // 复刻 worker 现状：spawn 时显式 thinking（adaptive + summarized 可读摘要）
  options.thinking = { type: "adaptive" };
} else {
  // 复刻备选方案：不带 thinking option，靠 settings 层控制（默认即自动思考）
  options.settings = { alwaysThinkingEnabled: true };
}

const q = query({ prompt: prompts(), options });
push(THINK_PROMPT);

let results = 0;
const flag = async (label: string, settings: any) => {
  console.log(`>>> [${label}] applyFlagSettings(${JSON.stringify(settings)})`);
  await q.applyFlagSettings(settings);
};

const seenTypes = new Set<string>();
for await (const msg of q as any) {
  if (msg.type === "stream_event") {
    const t = msg.event?.type;
    if (!seenTypes.has(t)) { seenTypes.add(t); console.log("EVENT_TYPE:", t); }
    if (t === "thinking_delta") {
      console.log("THINKING_DELTA:", JSON.stringify(msg.event.delta?.slice(0, 40)));
    }
    if (t === "message_start") {
      console.log("MSG_START:", JSON.stringify(msg.event.message?.model ?? ""));
    }
  }
  if (msg.type === "assistant") {
    const types = (msg.message?.content ?? []).map((b: any) => b.type);
    console.log(`ASSISTANT blocks: ${JSON.stringify(types)}`);
  } else if (msg.type === "result") {
    results++;
    console.log(`=== RESULT ${results} === ${msg.subtype}`);
    if (results === 1) {
      // 第 1 轮后：切「快速」——测试点：思考是否被关掉
      await flag("快速", { effortLevel: "low", alwaysThinkingEnabled: false });
      push(THINK_PROMPT);
    } else if (results === 2) {
      // 第 2 轮后：切回「思考」——思考应恢复
      await flag("high", { effortLevel: "high", alwaysThinkingEnabled: true });
      // 第 3 轮：尝试用 setMaxThinkingTokens 恢复思考（applyFlagSettings 的 true 无效）
      console.log(">>> setMaxThinkingTokens(32000) 恢复通道");
      await (q as any).setMaxThinkingTokens(32000);
      push(THINK_PROMPT);
    } else if (results === 3) {
      // 第 4 轮：验证 setMaxThinkingTokens 是否恢复
      push(THINK_PROMPT);
    } else {
      break;
    }
  }
}
process.exit(0);
