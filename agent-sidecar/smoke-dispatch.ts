// 冒烟：验证散装 skills/agents 经 plugins 旁路真正注入 agent。
// 用法（agent-sidecar 目录）：
//   npx tsx smoke-dispatch.ts            # trusted（默认），验证 aide-user: + aide-project:
//   SMOKE_TRUSTED=0 npx tsx smoke-dispatch.ts   # !trusted，验证无 aide-project:
//   SMOKE_CWD=/path/to/project npx tsx smoke-dispatch.ts  # 指定项目目录
// 依赖：claude.exe（优先 AIDE_CLAUDE_EXE，否则 SDK 平台包内）+ API key。
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDispatchPluginsOption } from "./src/dispatchPlugins.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// claude.exe：优先 AIDE_CLAUDE_EXE，否则 SDK 平台包（win32-x64）内
const DEFAULT_CLAUDE_EXE = join(
  __dirname,
  "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
);
const claudeExe =
  process.env.AIDE_CLAUDE_EXE ??
  (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);

// CLAUDE_CONFIG_DIR：让 buildDispatchPluginsOption 与 SDK 子进程都拿到同一个 claude home
const home = process.env.CLAUDE_CONFIG_DIR ??
  join(process.env.USERPROFILE || process.env.HOME || "", ".aide/claude");
process.env.CLAUDE_CONFIG_DIR = home;

const cwd = process.env.SMOKE_CWD ?? process.cwd();
const trusted = (process.env.SMOKE_TRUSTED ?? "1") !== "0";

const plugins = buildDispatchPluginsOption(cwd, trusted, false);
console.log("=== dispatch plugins ===");
console.log(JSON.stringify(plugins, null, 2));
console.log("claude home:", home, "cwd:", cwd, "trusted:", trusted);
if (plugins.length === 0) {
  console.log("⚠ 没有散装 plugin 注入——检查 ~/.aide/claude/skills/ 和 {cwd}/.aide/claude/skills/ 是否有 SKILL.md");
}

const env: Record<string, string | undefined> = { ...process.env };

const q = query({
  prompt: "What skills do you have available? List the names only, briefly.",
  options: {
    plugins,
    skills: "all",
    settingSources: [],
    cwd,
    env,
    allowedTools: [],
    permissionMode: "dontAsk",
    maxTurns: 1,
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
  },
});

for await (const msg of q as any) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("=== INIT ===");
    console.log("plugins:", JSON.stringify(msg.plugins));
    console.log("skills:", JSON.stringify(msg.skills));
    console.log("slash_commands:", JSON.stringify(msg.slash_commands));
    console.log("mcp_servers:", JSON.stringify(msg.mcp_servers));
  } else if (msg.type === "assistant") {
    for (const b of msg.message?.content ?? []) {
      if (b.type === "text" && b.text?.trim()) console.log("TEXT:", b.text.slice(0, 300));
    }
  } else if (msg.type === "result") {
    console.log("=== RESULT ===", msg.subtype, "cost:", msg.total_cost_usd);
    break;
  }
}
