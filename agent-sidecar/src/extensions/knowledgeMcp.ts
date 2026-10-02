// aide-knowledge（知识库读写）MCP server 注册。
// 组织文件在上层，子实现各自独立（knowledgeTools.ts + knowledge/ 子目录）。
//
// 注册条件（任一不满足即 null）：
// - `AIDE_KB_TOOLS=off`：operator 级开关（调试 / 不想让 agent 碰知识库的部署）。
// - `!trusted`：受限模式不暴露知识库读写。
// **刻意不设「配置了才挂」的第四道门**：未登录也挂载，调用返回「去知识库面板登录」
// 的引导文本——工具列表跨会话稳定，且会话中途第一次登录能当场生效（设计 spec §5.1）。
//
// server 实例 per-worker 构造；**无 emit 参数**——本 server 直连知识库的 HTTP，
// 不走主进程 IPC。
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { buildKnowledgeTools } from "./knowledgeTools.js";

/**
 * allowedTools 规则：**工具级**，只放行四个读工具。
 *
 * ⚠️ 不要照抄 docs 的 server 级规则（`mcp__aide-docs`）——那是「整个
 * server 都只读」才成立的写法。本 server 混着写工具，server 级规则会把写操作一起
 * 放行，破坏「写必弹窗」（设计 spec §7）。
 */
export const KNOWLEDGE_READ_RULES = [
  "mcp__aide-knowledge__search",
  "mcp__aide-knowledge__read_document",
  "mcp__aide-knowledge__list_spaces",
  "mcp__aide-knowledge__list_documents",
] as const;

/**
 * MCP instructions 块（initialize 时呈现给模型）。2026-07-26 冒烟实锤：
 * 没有它时模型对第三方 MCP 工具视而不见，连 prompt 直接点名都会被无视——这不是优化
 * 是必需品。删除或弱化前必须先跑 agent-sidecar/smoke-mcp.ts 验证行为不退化。
 */
export const KNOWLEDGE_INSTRUCTIONS = `This environment has built-in tools for the user's team knowledge base (知识库), exposed as the aide-knowledge MCP server. Rules:
1. USE ONLY ON EXPLICIT REQUEST. Call these tools only when the user explicitly mentions the knowledge base (知识库 / 存到知识库 / 查一下知识库). Never search the knowledge base proactively.
2. To find content you MUST call mcp__aide-knowledge__search first — never guess document ids, and never try to read knowledge base content with Grep/Read (it lives in a server, not in the workspace). Then mcp__aide-knowledge__read_document with the documentId from the hits.
3. Don't know what exists? Use mcp__aide-knowledge__list_spaces then mcp__aide-knowledge__list_documents to browse instead of guessing.
4. Cite documents as 知识库《标题》, and summarize instead of pasting a whole document back to the user.
5. FAILURES COME BACK AS TEXT with the next step (not connected / login expired / locked / unreachable). Follow the hint: if it says the user must sign in, tell them to sign in from the 知识库 panel and retry.
6. WRITING: append_document adds to the end and keeps what is there (the safe default for accumulating findings); update_document REPLACES the whole body, so read_document first and carry over the rest; create_document makes a new document; ingest_file imports a local file from disk (md/txt/docx/pdf) — pass a path instead of pasting a large file's content. delete_document removes a document AND every sub-document under it from every list, search and read path, and the panel has no restore — call it only when the user explicitly asks to delete that document, never on your own initiative.
7. NEVER GUESS A SPACE when writing. Call mcp__aide-knowledge__list_spaces first; if more than one space is visible and the user did not say which, ask the user — knowledge base writes land somewhere other people can see.
8. Every write is confirmed by the user through a permission prompt. Say which space and document you are about to write to in the same message, so the prompt is easy to judge.
9. If a write fails, report the failure text to the user instead of retrying blindly. Never save the content to a local file as a fallback unless the user asks.`;

/**
 * 默认注册。`trusted=false` 或 `AIDE_KB_TOOLS=off` → null。
 * 省略 trusted = 信任（向后兼容，测试与手工调用用）。
 * `cwd` 只往下传给 `ingest_file`（相对路径按会话工作目录解析）。
 */
export function knowledgeMcpRegistration(
  env: NodeJS.ProcessEnv = process.env,
  trusted = true,
  cwd = "",
): Record<string, unknown> | null {
  if (!trusted) return null;
  if (env.AIDE_KB_TOOLS === "off") return null;

  const server = createSdkMcpServer({
    name: "aide-knowledge",
    version: "1.0.0",
    instructions: KNOWLEDGE_INSTRUCTIONS,
    tools: buildKnowledgeTools(env, cwd),
  });

  return { "aide-knowledge": server };
}
