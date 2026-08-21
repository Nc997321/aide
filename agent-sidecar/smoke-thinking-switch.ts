// 冒烟：思考开关（设置→通用）的 spawn 语义验证——复刻 worker 的 thinking 构造：
//   thinkingEnabled=false → {type:'disabled'}；true → {type:'adaptive'}
// 用法（agent-sidecar 目录）：npx tsx smoke-thinking-switch.ts [off|on]
//
// ⚠️ 2026-08-21 实测结论（mock anthropic 端点抓请求体）：
//   - thinking:disabled → CLI 请求体**不带 thinking 字段** → ollama 端点默认=模型自决
//     → GLM/deepseek 等推理模型必出思考块。API 层关不掉 ollama 的思考。
//   - alwaysThinkingEnabled:false（spawn settings 或 applyFlagSettings）→ CLI 完全
//     忽略（请求体不变、不剥除 thinking block）。
//   - 官方 API 上 disabled=无 thinking 字段=默认不思考，该通道有效。
//   - 因此 worker 的「启用思考」开关在 ollama 上只能展示层剥除（mapper showThinking），
//     本脚本的 off 模式在 ollama 上预期 FAIL（这是事实，不是 bug）。
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
const mode = process.argv[2] ?? "off";

// 复刻 session-worker startLoop 的 thinking 构造（btw 恒关 + 开关）。
// off-settings 走 settings 层（alwaysThinkingEnabled:false）对比 thinking 参数通道。
const thinkingEnabled = mode !== "off" && mode !== "off-settings";
const thinking = mode === "btw" ? { type: "disabled" as const } : thinkingEnabled
  ? { type: "adaptive" as const }
  : { type: "disabled" as const };
console.log("thinking =", JSON.stringify(thinking), "mode =", mode);

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

const q: any = query({
  prompt: prompts(),
  options: {
    model: "deepseek-v4-flash:cloud",
    settingSources: [],
    allowedTools: [],
    includePartialMessages: true,
    ...(mode === "off-settings" ? {} : { thinking }),
    ...(mode === "off-settings" ? { settings: { alwaysThinkingEnabled: false } } : {}),
    env,
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
  },
});
push(THINK_PROMPT);

let thinkingBlocks = 0;
for await (const msg of q) {
  if (msg.type === "assistant") {
    const types = (msg.message?.content ?? []).map((b: any) => b.type);
    if (types.includes("thinking")) thinkingBlocks++;
    console.log(`ASSISTANT blocks: ${JSON.stringify(types)}`);
  }
  if (msg.type === "result") {
    console.log(`=== RESULT ${msg.subtype} === thinkingBlocks=${thinkingBlocks}`);
    const isOff = mode === "off" || mode === "off-settings" || mode === "btw";
    console.log(isOff
      ? thinkingBlocks === 0 ? "PASS: 关思考无思考块" : "FAIL: 关了还有思考块（ollama 上预期如此，见文件头注释）"
      : thinkingBlocks > 0 ? "PASS: 开思考有思考块" : "FAIL: 开了没思考块");
    process.exit(0);
  }
}
process.exit(0);
