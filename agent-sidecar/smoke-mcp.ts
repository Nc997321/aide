// 冒烟：headless 验证 inline SDK MCP server 是否真正把工具暴露给模型、且 instructions
// 让模型采纳工具（2026-07-26 codegraph 实锤：instructions 缺失时第三方模型对工具视而不见）。
// 用法（agent-sidecar 目录）：npx tsx smoke-mcp.ts
// 需 AIDE_CLAUDE_EXE 指向 claude.exe（SDK 平台包里的），否则用 DEFAULT_CLAUDE_EXE 兜底。
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync } from "node:fs";
// 直接用生产门面导出的 instructions 常量，确保冒烟用的就是注入模型的那一份（防文案漂移）。
import { CODEGRAPH_INSTRUCTIONS } from "./src/codegraphTools.js";
import { DOCX_INSTRUCTIONS } from "./src/docxTools.js";

// dev 默认用 SDK 平台包里的 claude.exe，免设 AIDE_CLAUDE_EXE。
const DEFAULT_CLAUDE_EXE =
  process.env.USERPROFILE +
  "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const claudeExe = process.env.AIDE_CLAUDE_EXE ?? (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);

const codegraphServer = createSdkMcpServer({
  name: "aide-codegraph",
  version: "1.0.0",
  instructions: CODEGRAPH_INSTRUCTIONS,
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

const docxServer = createSdkMcpServer({
  name: "aide-docs",
  version: "1.0.0",
  instructions: DOCX_INSTRUCTIONS,
  tools: [
    tool(
      "read_docx",
      "Read a .docx (Word 2007+) file and return its content as markdown — headings/lists/tables preserved. Use this INSTEAD OF Read (binary garbage) or Bash+pandoc (often not installed).",
      { file_path: z.string().describe("Path to the .docx file") },
      async (args) => ({
        content: [
          {
            type: "text" as const,
            text: `# MOCK ${String((args as any).file_path)}\n\n## 虫情数据 API\n\n这是 mock docx 内容，read_docx 已被调用。`,
          },
        ],
      }),
    ),
  ],
});

const env: Record<string, string | undefined> = {
  ...process.env,
  CLAUDE_CONFIG_DIR: process.env.USERPROFILE + "/.aide/claude",
};

async function runQuery(
  label: string,
  prompt: string,
  mcpServers: Record<string, unknown>,
  allowedTools: string[],
  toolFilter: string,
): Promise<string[]> {
  console.log(`\n=== QUERY: ${label} ===`);
  const toolUses: string[] = [];
  const q = query({
    prompt,
    options: {
      mcpServers,
      allowedTools,
      settingSources: ["project", "user"],
      cwd: process.cwd(),
      env,
      ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
    },
  });
  for await (const msg of q as any) {
    if (msg.type === "system" && msg.subtype === "init") {
      console.log("=== INIT ===");
      console.log("mcp_servers:", JSON.stringify(msg.mcp_servers));
      const tools: string[] = msg.tools ?? [];
      console.log(`${label} tools in list:`, tools.filter((t) => t.includes(toolFilter)));
    } else if (msg.type === "assistant") {
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use") {
          console.log("TOOL_USE:", b.name, JSON.stringify(b.input));
          toolUses.push(b.name);
        }
        if (b.type === "text" && b.text?.trim()) console.log("TEXT:", b.text.slice(0, 120));
      }
    } else if (msg.type === "result") {
      console.log("=== RESULT ===", msg.subtype, "cost:", msg.total_cost_usd);
      break;
    }
  }
  return toolUses;
}

// 1) codegraph 冒烟（原验：find_symbol 被调）
await runQuery(
  "codegraph",
  "Use the find_symbol tool to look up 'save'. Then reply with exactly: ok",
  { "aide-codegraph": codegraphServer },
  ["mcp__aide-codegraph"],
  "codegraph",
);

// 2) docx 冒烟——验证 instructions 是否让模型采纳 read_docx（instructions 缺失时模型无视工具）
const docxTools = await runQuery(
  "docx",
  "Read the file /tmp/example.docx and summarize its content in one line.",
  { "aide-docs": docxServer },
  ["mcp__aide-docs"],
  "docs",
);
if (!docxTools.some((n) => n.includes("read_docx"))) {
  console.error("\nFAIL: model did not call read_docx — DOCX_INSTRUCTIONS may be ineffective");
  process.exit(1);
}
console.log("\nPASS: read_docx was called");