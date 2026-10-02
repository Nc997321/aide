// aide-knowledge 的工具定义（P1 = 4 个读工具，P2 = 4 个写工具，软删 = delete_document）。
//
// 读写两条壳：kbCall 服务「一次请求」的读工具，kbWrite 服务「先读后写」的写工具
// （多步操作在 knowledge/operations.ts）。写工具**不在** allowedTools 白名单里，
// 每次调用都要过 canUseTool 弹窗（spec §7）。
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
  formatDocumentList,
  formatDocumentView,
  formatFailure,
  formatSearchHits,
  formatSpaces,
} from "./knowledge/format.js";
import {
  appendToDocument,
  createDocument,
  createFolder,
  deleteDocument,
  ingestFile,
  moveDocument,
  resolveWriteTarget,
  updateDocument,
} from "./knowledge/operations.js";

// 必须是 type 别名而不是 interface：SDK 的 CallToolResult 带 `[x: string]: unknown` 索引
// 签名，只有匿名对象类型（type 别名）才有隐式索引签名，interface 没有 → handler 返回
// ToolResult 会报 TS2322。
type ToolResult = {
  content: { type: "text"; text: string }[];
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 未归一的异常 → 文本：2xx 但形状不对（格式化器解引用畸形数据）、或任何穿出来的异常
 * 一律降级，绝不穿出 handler（MCP 会把抛出的 handler 变成 isError = 本模块的红线）。
 * 带上原始信息：否则「服务端返回畸形数据」与「我们自己有笔误」给出同一句话，零可观测性。
 */
function shapeFailure(e: unknown): ToolResult {
  const detail = e instanceof Error ? e.message : String(e);
  return textResult(formatFailure({ kind: "bad_response", detail: `unexpected response shape: ${detail}` }));
}

/**
 * 单请求工具的公共壳：现读凭据 → 建客户端 → 跑一次请求 → 成功/失败各走格式化器。
 * 永不抛（工具层红线）。多请求工具（P2 的 append / ingest）走 kbWrite。
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
  } catch (e) {
    return shapeFailure(e);
  }
}

/**
 * 写工具壳：现读凭据 → 建客户端 → 跑一个多步操作（操作自己产出给模型看的文本）。
 * 与 kbCall 的分工：kbCall 服务「一次请求」的工具，这里服务「先读后写」的工具。
 * 同样永不抛：写工具也会先 GET（/api/spaces 或文档），畸形 2xx 下 decideSpace 解构
 * 非数组会抛 TypeError——没有这层 catch 就是 MCP 的 isError（spec §5.2 红线，无例外）。
 */
async function kbWrite(env: NodeJS.ProcessEnv, op: (client: KbClient) => Promise<string>): Promise<ToolResult> {
  const cfg = readKbConfig(env);
  if (!cfg) return textResult(KB_NOT_CONNECTED_TEXT);
  try {
    return textResult(await op(createKbClient(cfg)));
  } catch (e) {
    return shapeFailure(e);
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
    "Read one knowledge base document (markdown) with its version number. By default returns the whole body. For long documents save context: call with outline: true to get the headings with line ranges, then read just one part with section (a heading's text) or startLine/endLine. Read the whole body before updating or appending so you edit what is actually there.",
    {
      documentId: z.string().describe("Document id (uuid) from search or list_documents"),
      outline: z.boolean().optional().describe("true = return only the heading outline with line ranges (no body). Use it first on a long document."),
      section: z.string().optional().describe("Read just the section under this heading (matched by its text, sub-sections included). Take the text from the outline."),
      startLine: z.number().int().min(1).optional().describe("Read from this line (1-based). With endLine, reads that inclusive range; without it, to the end."),
      endLine: z.number().int().min(1).optional().describe("Last line to read (inclusive). Only meaningful with startLine."),
    },
    (args) =>
      kbCall<KbDocument>(
        env,
        (c) => c.getJson<KbDocument>(docPath(args.documentId)),
        (doc) =>
          formatDocumentView(doc, {
            ...(args.outline ? { outline: true } : {}),
            ...(args.section ? { section: args.section } : {}),
            ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
            ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
          }),
      ),
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
    "List the nodes in one knowledge base space as a flat tree (id / parentId / title / versionNo / updatedAt). Each line is tagged [folder] or [doc]: a [folder] is a container that holds no content, a [doc] holds the content — pass a [folder] id as parentId to create or move things into it. Use it to browse what exists when the user has not named a document.",
    { spaceId: z.string().describe("Space id from list_spaces") },
    (args) =>
      kbCall<KbDocumentSummary[]>(
        env,
        (c) => c.getJson<KbDocumentSummary[]>(spaceDocsPath(args.spaceId)),
        formatDocumentList,
      ),
  );
}

function buildCreateDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "create_document",
    "Create a NEW knowledge base document (title + markdown content). Use it when the user asks to save something that does not exist yet — use append_document to add to an existing document instead of creating a duplicate.",
    {
      title: z.string().describe("Document title (also becomes the URL slug)"),
      content: z.string().describe("Document body in markdown"),
      spaceId: z.string().optional().describe("Target space id from list_spaces. Omit only when the user's target is unambiguous."),
      parentId: z.string().optional().describe("Parent FOLDER id to nest under. Omit for a top-level document. Only folders can hold children."),
    },
    (args) =>
      kbWrite(env, async (client) => {
        const target = await resolveWriteTarget(client, args.spaceId);
        if (target.kind === "ask") return target.text;
        return createDocument(client, {
          spaceId: target.id,
          title: args.title,
          content: args.content,
          ...(args.parentId ? { parentId: args.parentId } : {}),
        });
      }),
  );
}

function buildCreateFolderTool(env: NodeJS.ProcessEnv) {
  return tool(
    "create_folder",
    "Create a knowledge base FOLDER — a container node that holds no content. Use it to build a directory structure before filing documents into it; then pass the folder's id as parentId to create_document or ingest_file. Folders can be nested inside other folders, but a [doc] can never hold children.",
    {
      title: z.string().describe("Folder name, e.g. '运维手册'"),
      spaceId: z.string().optional().describe("Target space id from list_spaces. Omit only when the user's target is unambiguous."),
      parentId: z.string().optional().describe("Parent FOLDER id to nest under. Omit for a top-level folder."),
    },
    (args) =>
      kbWrite(env, async (client) => {
        const target = await resolveWriteTarget(client, args.spaceId);
        if (target.kind === "ask") return target.text;
        return createFolder(client, {
          spaceId: target.id,
          title: args.title,
          ...(args.parentId ? { parentId: args.parentId } : {}),
        });
      }),
  );
}

function buildMoveDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "move_document",
    "Move an existing knowledge base node (document or folder) to another folder, or back to the top level. This changes where it sits in the tree — it does not change its content or its id. Call list_documents first to find the destination folder's id.",
    {
      documentId: z.string().describe("Id of the node to move (document or folder)"),
      parentId: z.string().optional().describe("Destination FOLDER id. Omit to move it to the top level of its space."),
    },
    (args) =>
      kbWrite(env, (client) =>
        moveDocument(client, {
          documentId: args.documentId,
          ...(args.parentId ? { parentId: args.parentId } : {}),
        }),
      ),
  );
}

function buildAppendDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "append_document",
    "Append markdown to the END of an existing knowledge base document, keeping everything already there. This is the safe default for accumulating findings — prefer it over update_document. Call read_document first if you need to see what is already in the document.",
    {
      documentId: z.string().describe("Document id (uuid) from search or list_documents"),
      content: z.string().describe("Markdown to append at the end of the document"),
      changeNote: z.string().optional().describe("Short note recorded in the revision history"),
    },
    (args) =>
      kbWrite(env, (client) =>
        appendToDocument(client, {
          documentId: args.documentId,
          content: args.content,
          ...(args.changeNote ? { changeNote: args.changeNote } : {}),
        }),
      ),
  );
}

function buildUpdateDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "update_document",
    "Replace the WHOLE body of an existing knowledge base document. Read it with read_document first and carry over the parts you are not changing — this overwrites everything. Prefer append_document when you are only adding something.",
    {
      documentId: z.string().describe("Document id (uuid) from search or list_documents"),
      content: z.string().describe("The complete new document body in markdown"),
      title: z.string().optional().describe("New title. Omit to keep the current title."),
      changeNote: z.string().optional().describe("Short note recorded in the revision history"),
    },
    (args) =>
      kbWrite(env, (client) =>
        updateDocument(client, {
          documentId: args.documentId,
          content: args.content,
          ...(args.title ? { title: args.title } : {}),
          ...(args.changeNote ? { changeNote: args.changeNote } : {}),
        }),
      ),
  );
}

function buildIngestFileTool(env: NodeJS.ProcessEnv, cwd: string) {
  return tool(
    "ingest_file",
    "Import a local file from disk into the knowledge base (md, markdown, txt, docx, pdf — the server parses it into markdown). Use this instead of pasting a large file's content into create_document. Relative paths resolve against the session working directory.",
    {
      filePath: z.string().describe("Path to the file on disk (absolute, or relative to the session working directory)"),
      spaceId: z.string().optional().describe("Target space id from list_spaces. Omit only when the user's target is unambiguous."),
      parentId: z.string().optional().describe("Parent FOLDER id to nest under. Omit for a top-level document. Only folders can hold children."),
    },
    (args) =>
      kbWrite(env, async (client) => {
        const target = await resolveWriteTarget(client, args.spaceId);
        if (target.kind === "ask") return target.text;
        return ingestFile(client, cwd, {
          filePath: args.filePath,
          spaceId: target.id,
          ...(args.parentId ? { parentId: args.parentId } : {}),
        });
      }),
  );
}

function buildDeleteDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "delete_document",
    "Delete a knowledge base node together with everything under it (sub-folders and documents alike). This is a soft delete: it disappears from every list, search and read path, and the 知识库 panel has NO restore — use it only when the user explicitly names something to delete, never to tidy up on your own.",
    { documentId: z.string().describe("Document id (uuid) from search or list_documents") },
    (args) => kbWrite(env, (client) => deleteDocument(client, { documentId: args.documentId })),
  );
}

/** 工具总装：本文件唯一的编排点（一张表，不加逻辑）。cwd 只服务 ingest_file 的相对路径。 */
export function buildKnowledgeTools(env: NodeJS.ProcessEnv, cwd: string) {
  return [
    buildSearchTool(env),
    buildReadDocumentTool(env),
    buildListSpacesTool(env),
    buildListDocumentsTool(env),
    buildCreateDocumentTool(env),
    buildCreateFolderTool(env),
    buildMoveDocumentTool(env),
    buildAppendDocumentTool(env),
    buildUpdateDocumentTool(env),
    buildIngestFileTool(env, cwd),
    buildDeleteDocumentTool(env),
  ];
}
