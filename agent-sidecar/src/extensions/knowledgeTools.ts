// aide-knowledge 的工具定义（P1 = 4 个读工具；写工具见 P2 计划）。
//
// 组织：本文件上层只做编排（buildKnowledgeTools 是一张表），每个工具一个
// buildXxxTool，各自成形、互不依赖。
//
// **凭据在每次调用现读**（readKbConfig）——MCP server 的闭包值随 query() spawn 冻结
// （session-worker.ts 的 startLoop → queryContext.ts），会话中途重新登录知识库后旧值
// 会一直用到开新会话；现读让重登自愈，也让「未登录」能返回引导文本而不是没有工具
// （设计 spec §3 / §5.1）。
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { readKbConfig } from "./knowledge/config.js";
import {
  createKbClient,
  docPath,
  spaceDocsPath,
  type KbClient,
  type KbDocument,
  type KbDocumentSummary,
  type KbResult,
  type KbSearchResult,
  type KbSpace,
} from "./knowledge/client.js";
import {
  KB_NOT_CONNECTED_TEXT,
  formatDocument,
  formatDocumentList,
  formatFailure,
  formatSearchHits,
  formatSpaces,
} from "./knowledge/format.js";

// 必须是 type 别名而不是 interface：SDK 的 CallToolResult 带 `[x: string]: unknown` 索引
// 签名，只有匿名对象类型（type 别名）才有隐式索引签名，interface 没有 → handler 返回
// ToolResult 会报 TS2322（codegraphTools.ts 因不声明具名类型而天然避开）。
type ToolResult = {
  content: { type: "text"; text: string }[];
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 单请求工具的公共壳：现读凭据 → 建客户端 → 跑一次请求 → 成功/失败各走格式化器。
 * 永不抛（工具层红线）。多请求工具（P2 的 append / ingest）自己组合这几步。
 */
async function kbCall<T>(
  env: NodeJS.ProcessEnv,
  run: (client: KbClient) => Promise<KbResult<T>>,
  onOk: (data: T) => string,
): Promise<ToolResult> {
  const cfg = readKbConfig(env);
  if (!cfg) return textResult(KB_NOT_CONNECTED_TEXT);
  try {
    const r = await run(createKbClient(cfg));
    return textResult(r.ok ? onOk(r.data) : formatFailure(r.failure));
  } catch {
    // 2xx 但形状不对（格式化器解引用畸形数据）、或任何未归一的异常：一律降级成
    // 文本，绝不穿出 handler（MCP 会把抛出的 handler 变成 isError = 本模块的红线）。
    return textResult(formatFailure({ kind: "bad_response", detail: "unexpected response shape" }));
  }
}

function buildSearchTool(env: NodeJS.ProcessEnv) {
  return tool(
    "search",
    "Full-text search across the team knowledge base (the server tokenizes Chinese itself). Returns matching documents with a snippet, each carrying the documentId needed by read_document. Use natural keywords, not SQL/LIKE patterns.",
    {
      query: z.string().describe("Search keywords, e.g. '部署回滚' or 'release checklist'"),
      spaceId: z.string().optional().describe("Restrict to one space id (from list_spaces). Omit to search every space the user can read."),
      limit: z.number().int().min(1).max(100).optional().describe("Max hits (default 20, server caps at 100)"),
    },
    (args) =>
      kbCall<KbSearchResult>(
        env,
        (c) => c.getJson<KbSearchResult>("/api/search", { q: args.query, spaceId: args.spaceId, limit: args.limit }),
        formatSearchHits,
      ),
  );
}

function buildReadDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "read_document",
    "Read one knowledge base document in full (markdown) together with its version number. Call this before updating or appending to a document so you edit what is actually there.",
    { documentId: z.string().describe("Document id (uuid) from search or list_documents") },
    (args) =>
      kbCall<KbDocument>(env, (c) => c.getJson<KbDocument>(docPath(args.documentId)), formatDocument),
  );
}

function buildListSpacesTool(env: NodeJS.ProcessEnv) {
  return tool(
    "list_spaces",
    "List the knowledge base spaces (id / key / name / role) the signed-in user can see. This is how you learn the spaceId other tools need.",
    {},
    () => kbCall<KbSpace[]>(env, (c) => c.getJson<KbSpace[]>("/api/spaces"), formatSpaces),
  );
}

function buildListDocumentsTool(env: NodeJS.ProcessEnv) {
  return tool(
    "list_documents",
    "List the documents in one knowledge base space (flat tree: id / parentId / title / versionNo / updatedAt). Use it to browse what exists when the user has not named a document.",
    { spaceId: z.string().describe("Space id from list_spaces") },
    (args) =>
      kbCall<KbDocumentSummary[]>(
        env,
        (c) => c.getJson<KbDocumentSummary[]>(spaceDocsPath(args.spaceId)),
        formatDocumentList,
      ),
  );
}

/** 工具总装：本文件唯一的编排点（一张表，不加逻辑）。 */
export function buildKnowledgeTools(env: NodeJS.ProcessEnv) {
  return [
    buildSearchTool(env),
    buildReadDocumentTool(env),
    buildListSpacesTool(env),
    buildListDocumentsTool(env),
  ];
}
