// 冒烟：headless 验证 SDK 0.3.197 的 in-process MCP server 是否真正把工具暴露给模型。
// 用法（agent-sidecar 目录）：npx tsx smoke-mcp.ts
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync } from "node:fs";

// dev 默认用 SDK 平台包里的 claude.exe，免设 AIDE_CLAUDE_EXE。
const DEFAULT_CLAUDE_EXE =
  process.env.USERPROFILE +
  "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const claudeExe = process.env.AIDE_CLAUDE_EXE ?? (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);

const STEERING = `This environment has a PRE-BUILT code index for the current workspace, exposed as the aide-codegraph MCP tools (find_symbol / semantic_search / call_graph). Rules:
1. When you need to find where a symbol is defined, you MUST call mcp__aide-codegraph__find_symbol FIRST — do NOT use Grep for definition lookup.
2. When you need callers/callees of a function, you MUST call mcp__aide-codegraph__call_graph FIRST.
3. When you know what code does but not its name, use mcp__aide-codegraph__semantic_search.
Grep is for text/pattern search, NOT for locating symbols. These tools are exact, instant, and cheaper than a grep-then-read fan-out.`;

const server = createSdkMcpServer({
  name: "aide-codegraph",
  version: "1.0.0",
  instructions: STEERING,
  tools: [
    tool(
      "find_symbol",
      "Locate the exact definition of a symbol (function/class/method/interface/enum) by name across the indexed project. Returns file:line for each definition. STRONGLY PREFER this over Grep when you need to find where something is defined.",
      { name: z.string().describe("Symbol name") },
      async (args) => ({
        content: [{ type: "text" as const, text: `MOCK find_symbol(${String((args as any).name)}) -> mock.ts:1` }],
      }),
    ),
  ],
});

const env: Record<string, string | undefined> = {
  ...process.env,
  CLAUDE_CONFIG_DIR: process.env.USERPROFILE + "/.aide/claude",
};

const q = query({
  prompt:
    "Use the find_symbol tool to look up 'save'. Then reply with exactly: ok",
  options: {
    mcpServers: { "aide-codegraph": server },
    allowedTools: ["mcp__aide-codegraph"],
    settingSources: ["project", "user"],
    cwd: "C:/Users/<user>/IdeaProjects/aide",
    env,
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
  },
});

for await (const msg of q as any) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("=== INIT ===");
    console.log("mcp_servers:", JSON.stringify(msg.mcp_servers));
    const tools: string[] = msg.tools ?? [];
    console.log("codegraph tools in tools list:", tools.filter((t) => t.includes("codegraph")));
  } else if (msg.type === "assistant") {
    for (const b of msg.message?.content ?? []) {
      if (b.type === "tool_use") console.log("TOOL_USE:", b.name, JSON.stringify(b.input));
      if (b.type === "text" && b.text?.trim()) console.log("TEXT:", b.text.slice(0, 120));
    }
  } else if (msg.type === "result") {
    console.log("=== RESULT ===", msg.subtype, "cost:", msg.total_cost_usd);
    break;
  }
}
