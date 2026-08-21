// 探针 v2：用 ollama anthropic 兼容端点（用户实际通道）验证 thinking 行为。
// env：ANTHROPIC_BASE_URL=http://localhost:11434；model 走 glm-5.2（cloud）。
// 用法：npx tsx smoke-thinking-probe.ts <thinking-mode>
//   thinking-mode: adaptive|disabled|none （none = 不带 thinking option，靠 settings 层）
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

const mode = process.argv[2] ?? "adaptive";

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

const options: any = {
  model: "glm-5.2:cloud",
  settingSources: [],
  allowedTools: [],
  effort: "high" as const,
  includePartialMessages: true,
  env,
  ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
};
if (mode === "adaptive") options.thinking = { type: "adaptive", display: "summarized" };
if (mode === "disabled") options.thinking = { type: "disabled" };

console.log(`MODE=${mode} spawn: model=glm-5.2 effort=high via ollama`);
const q = query({ prompt: prompts(), options });
push("用反证法证明 √2 是无理数，写完整推理。只输出答案。");

const typeCount: Record<string, number> = {};
let thinkingLen = 0;
for await (const msg of q as any) {
  typeCount[msg.type] = (typeCount[msg.type] ?? 0) + 1;
  if (msg.type === "stream_event") {
    const ev = msg.event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
      thinkingLen += ev.delta.thinking.length;
    }
  } else if (msg.type === "assistant") {
    const blocks = (msg.message?.content ?? []) as any[];
    console.log("  ASSISTANT blocks:", JSON.stringify(blocks.map((b) => b.type)));
  } else if (msg.type === "result") {
    console.log(`=== RESULT ${msg.subtype} ===`);
    break;
  }
}
console.log("msg.type counts:", JSON.stringify(typeCount), "| thinking chars streamed:", thinkingLen);
process.exit(0);
