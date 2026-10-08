// 冒烟：直连 SDK 验证 inline SDK MCP server 是否真正把工具暴露给模型、且 instructions
// 让模型采纳工具（2026-07-26 实锤：instructions 缺失时第三方模型对工具视而不见）。
// 用法（agent-sidecar 目录）：npx tsx smoke-mcp.ts
// 需 AIDE_CLAUDE_EXE 指向 claude.exe（SDK 平台包里的），否则用 DEFAULT_CLAUDE_EXE 兜底。
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync } from "node:fs";
// 直接用生产门面导出的 instructions 常量，确保冒烟用的就是注入模型的那一份（防文案漂移）。
import { DOCS_INSTRUCTIONS } from "./src/extensions/docsMcp.js";
import { KNOWLEDGE_INSTRUCTIONS } from "./src/extensions/knowledgeMcp.js";
import { BROWSER_INSTRUCTIONS } from "./src/extensions/browserMcp.js";

// dev 默认用 SDK 平台包里的 claude.exe，免设 AIDE_CLAUDE_EXE。
const DEFAULT_CLAUDE_EXE =
  process.env.USERPROFILE +
  "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const claudeExe = process.env.AIDE_CLAUDE_EXE ?? (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);

const docxServer = createSdkMcpServer({
  name: "aide-docs",
  version: "1.0.0",
  instructions: DOCS_INSTRUCTIONS,
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
    tool(
      "read_pdf",
      "Read a .pdf file and return its content as markdown — text extracted per page (## Page N), layout reconstructed from coordinates. Images are counted but not extracted. Use this INSTEAD OF Read (binary garbage) or Bash+pdftotext (often not installed). For long documents, call with mode: \"structure\" first, then read specific pages with pages.",
      {
        file_path: z.string().describe("Path to the .pdf file"),
        pages: z.string().optional().describe('Page range: "3", "1-5", or "1,3,5-7"'),
        mode: z.enum(["markdown", "structure"]).optional().describe("Output mode"),
      },
      async (args) => ({
        content: [
          {
            type: "text" as const,
            text: `# MOCK ${String((args as any).file_path)}\n\n## Page 1\n\n这是 mock pdf 内容，read_pdf 已被调用。`,
          },
        ],
      }),
    ),
    tool(
      "write_docx",
      "Write a markdown string to a .docx (Word 2007+) file. Converts markdown to a real .docx — headings, lists, tables, code blocks, blockquotes, and local images supported. Use this INSTEAD OF Bash+python-docx/pandoc (often not installed). Refuses to overwrite an existing file unless overwrite: true is passed.",
      {
        file_path: z.string().describe("Path where the .docx file will be written"),
        markdown: z.string().describe("Markdown content to convert to .docx"),
        overwrite: z.boolean().optional().describe("Set to true to overwrite an existing file"),
      },
      async (args) => ({
        content: [{ type: "text" as const, text: `# MOCK ${String((args as any).file_path)}\n\nWrote mock docx.` }],
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

// 1) docx 冒烟——验证 instructions 是否让模型采纳 read_docx（instructions 缺失时模型无视工具）
const docxTools = await runQuery(
  "docx",
  "Read the file /tmp/example.docx and summarize its content in one line.",
  { "aide-docs": docxServer },
  ["mcp__aide-docs"],
  "docs",
);
if (!docxTools.some((n) => n.includes("read_docx"))) {
  console.error("\nFAIL: model did not call read_docx — DOCS_INSTRUCTIONS may be ineffective");
  process.exit(1);
}
console.log("\nPASS: read_docx was called");

// 3) write_docx 冒烟——验证 instructions 让模型采纳 write_docx（同一 server，同一 instructions 块）
const docxGenTools = await runQuery(
  "docx-write",
  "Write a .docx file at /tmp/out.docx containing a short markdown document about the weather.",
  { "aide-docs": docxServer },
  ["mcp__aide-docs"],
  "docs",
);
if (!docxGenTools.some((n) => n.includes("write_docx"))) {
  console.error("\nFAIL: model did not call write_docx — DOCS_INSTRUCTIONS may be ineffective");
  process.exit(1);
}
console.log("\nPASS: write_docx was called");

// 4) read_pdf 冒烟——验证 instructions 让模型采纳 read_pdf（同一 server，同一 instructions 块）
const pdfTools = await runQuery(
  "pdf",
  "Read the file /tmp/example.pdf and summarize its content in one line.",
  { "aide-docs": docxServer },
  ["mcp__aide-docs"],
  "docs",
);
if (!pdfTools.some((n) => n.includes("read_pdf"))) {
  console.error("\nFAIL: model did not call read_pdf — DOCS_INSTRUCTIONS may be ineffective");
  process.exit(1);
}
console.log("\nPASS: read_pdf was called");

// 5) knowledge 冒烟——验证 instructions 让模型在「用户点名知识库」时采纳 search。
// 用 mock handler：本段验的是 instructions 的采纳率，不是知识库连通性（那由手工 E2E 验）。
const knowledgeServer = createSdkMcpServer({
  name: "aide-knowledge",
  version: "1.0.0",
  instructions: KNOWLEDGE_INSTRUCTIONS,
  tools: [
    tool(
      "search",
      "Full-text search across the team knowledge base. Returns matching documents with a snippet, each carrying the documentId needed by read_document.",
      { query: z.string().describe("Search keywords"), spaceId: z.string().optional().describe("Restrict to one space id") },
      async (args) => ({
        content: [{ type: "text" as const, text: `MOCK search(${String((args as any).query)}) -> 上线检查清单 (documentId d1)` }],
      }),
    ),
    tool(
      "list_spaces",
      "List the knowledge base spaces the signed-in user can see.",
      {},
      async () => ({ content: [{ type: "text" as const, text: "MOCK spaces: 工程 (id s1)" }] }),
    ),
  ],
});

const knowledgeTools = await runQuery(
  "knowledge",
  "帮我查一下知识库里关于「上线检查」的内容。",
  { "aide-knowledge": knowledgeServer },
  ["mcp__aide-knowledge__search", "mcp__aide-knowledge__list_spaces"],
  "knowledge",
);
if (!knowledgeTools.some((n) => n.includes("search") || n.includes("list_spaces"))) {
  console.error("\nFAIL: model did not call a knowledge tool — KNOWLEDGE_INSTRUCTIONS may be ineffective");
  process.exit(1);
}
console.log("\nPASS: knowledge tool was called");

// 6) browser 冒烟——验证 instructions 让模型在「用户指着页面」时采纳浏览器工具。
// 与知识库同理：mock handler，验的是 instructions 的采纳率；真驱动 WebView2 由桌面 E2E 验
// （那需要真的开着浏览器面板）。
const browserServer = createSdkMcpServer({
  name: "aide-browser",
  version: "1.0.0",
  instructions: BROWSER_INSTRUCTIONS,
  tools: [
    tool(
      "browser_tabs",
      "List the browser views (tabs) currently open in Aide's embedded browser, with each one's id, url, title and visibility.",
      {},
      async () => ({
        content: [{ type: "text" as const, text: "MOCK views: browser-1 [ready, visible] https://example.test/ledger" }],
      }),
    ),
    tool(
      "browser_read",
      "Read the page loaded in an embedded browser view as a STRUCTURED SKELETON: outline, tables, form fields, clickable elements.",
      { view_id: z.string().optional().describe("Target browser view id (from browser_tabs)") },
      async () => ({
        content: [{ type: "text" as const, text: "MOCK read: title=设备台账管理 tables=1 fields=3" }],
      }),
    ),
  ],
});

const browserTools = await runQuery(
  "browser",
  "帮我看一下我现在浏览器面板里打开的那个页面，把表格上的字段读出来。",
  { "aide-browser": browserServer },
  ["mcp__aide-browser__browser_tabs", "mcp__aide-browser__browser_read"],
  "browser",
);
if (!browserTools.some((n) => n.includes("browser_tabs") || n.includes("browser_read"))) {
  console.error("\nFAIL: model did not call a browser tool — BROWSER_INSTRUCTIONS may be ineffective");
  process.exit(1);
}
console.log("\nPASS: browser tool was called");