// 冒烟：effort 两条官方通道（spawn options.effort / 会话中 applyFlagSettings）。
// 实锤结论（2026-08-01）：
//  - applyFlagSettings({ effortLevel }) 中途切换有效，含 max；
//  - CLAUDE_CODE_EFFORT_LEVEL env 会压过 applyFlagSettings、并与 options.effort 就高合并
//    ——所以 sidecar 必须删掉该 env 的透传，effort 只走 query 选项 + applyFlagSettings；
//  - Stop hook 的 input.effort.level 是本轮实际档位的权威读数（含静默降级）。
// 用法（agent-sidecar 目录）：npx tsx smoke-effort.ts [spawn|flag] [level]
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
const DEFAULT_CLAUDE_EXE = process.env.USERPROFILE + "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const claudeExe = process.env.AIDE_CLAUDE_EXE ?? (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);
const env: Record<string, string | undefined> = {
  ...process.env,
  CLAUDE_CONFIG_DIR: process.env.USERPROFILE + "/.aide/claude",
};
delete env.CLAUDE_CODE_EFFORT_LEVEL;

const THINK_PROMPT = "估算 127*349 的精确值。先仔细心算验证两遍再回答，只输出最终数字。";
const mode = process.argv[2] ?? "spawn";

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

const q = query({
  prompt: prompts(),
  options: {
    model: "claude-opus-4-8",
    settingSources: [],
    allowedTools: [],
    hooks: { Stop: [{ hooks: [stopHook] }] },
    ...(mode === "spawn" ? { effort: "max" as const } : {}),
    env,
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
  },
});

push(THINK_PROMPT);

let results = 0;
for await (const msg of q as any) {
  if (msg.type === "assistant") {
    const types = (msg.message?.content ?? []).map((b: any) => b.type);
    console.log("ASSISTANT blocks:", JSON.stringify(types));
  } else if (msg.type === "result") {
    results++;
    console.log(`=== RESULT ${results} ===`, msg.subtype);
    if (mode === "flag" && results === 1) {
      console.log(">>> applyFlagSettings({ effortLevel: 'max' })");
      await (q as any).applyFlagSettings({ effortLevel: "max" });
      push(THINK_PROMPT);
    } else {
      break;
    }
  }
}
process.exit(0);
