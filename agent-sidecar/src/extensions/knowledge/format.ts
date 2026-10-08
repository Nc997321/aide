// 知识库工具返回文本的唯一产地（纯函数，单测直接覆盖）。
//
// 红线：失败也返回**文本**，永不 throw、永不 isError——工具报错会让 agent 纠结，
// 文本提示让它自然换路。每条失败文案都要写清「下一步」。
import type {
  KbDocument,
  KbDocumentSummary,
  KbFailure,
  KbIngestResult,
  KbSaveResult,
  KbSearchResult,
  KbSpace,
} from "./client.js";
import { findSection, parseOutline, sliceLines, type KbHeading } from "./outline.js";

/** 未配置 / 已登出时的引导文本（工具恒挂，未登录也有话可说——设计 spec §5.1）。 */
export const KB_NOT_CONNECTED_TEXT =
  "The knowledge base is not connected — no credentials are saved for this desktop. " +
  "Ask the user to sign in from the 知识库 panel, then retry (no new session is needed).";

/** `read_document` 输出上限：超出截断并显式注明。 */
export const KB_READ_MAX_CHARS = 100_000;

/** 不带选择器整篇读时，超过这个长度就在开头提示「下次可以只读一节」。 */
export const KB_LONG_DOC_HINT_CHARS = 20_000;

/** 单次调用传入的 `content` 上限（append 只算新增段落）。 */
export const KB_CONTENT_MAX_BYTES = 256 * 1024;
/** append / update **写回后整篇正文**上限——没有这道闸，append 能绕过单次上限撑爆文档。 */
export const KB_DOC_MAX_BYTES = 1024 * 1024;
/**
 * `ingest_file` 导入文件上限。
 *
 * **服务端同步点**：`knowledge-server/src/api/mod.rs` 的 `INGEST_BODY_LIMIT`——那条必须
 * **严格大于**本值（客户端量文件、服务端量整个 multipart 体，差着分帧开销几百字节）。
 * 改了这里而没跟着改那边，超限的失败会退回服务端那句看不出原因的 400。此值另有实测用例钉住。
 */
export const KB_INGEST_MAX_BYTES = 32 * 1024 * 1024;

/** 摘要里的 `[[HL]]…[[/HL]]` 哨兵剥掉——服务端标记不该混进模型后续写回的正文。 */
export function stripHighlight(s: string): string {
  return s.replaceAll("[[HL]]", "").replaceAll("[[/HL]]", "");
}

/** 失败 → 下一步。switch 必须穷尽 KbFailure（漏一种 TS 会报 never）。 */
export function formatFailure(f: KbFailure): string {
  switch (f.kind) {
    case "unauthorized":
      return "The knowledge base rejected the saved credentials (401). Tell the user to sign in again from the 知识库 panel, then retry — no new session is needed.";
    case "forbidden":
      return "The signed-in account has no permission for this space or document (403). Ask the user to check space membership, or pick another space.";
    case "not_found":
      return "Not found (404) — the document may have been deleted, or the id is wrong. Use search or list_documents to locate it again.";
    case "locked":
      return `The document is currently locked by another editor (409): ${f.message}. Wait a moment and retry, or ask the user to close their editor.`;
    case "bad_request":
      return `The knowledge base rejected the request: ${f.message} Correct the input and retry.`;
    case "server":
      return `The knowledge base returned a server error (${f.status}). Retry once; if it persists, tell the user to check the knowledge base service.`;
    case "network":
      return `Could not reach the knowledge base at ${f.baseUrl} (${f.detail}). Retry once; if it persists, check that the service is running and that the address in the 知识库 panel is right.`;
    case "timeout":
      return "The knowledge base request timed out. Retry once; if it keeps timing out, tell the user the service may be overloaded.";
    case "bad_response":
      return `The knowledge base returned an unexpected response: ${f.detail} Retry once; if it persists, tell the user the response could not be parsed.`;
  }
}

export function formatSearchHits(data: KbSearchResult): string {
  const hits = data.hits;
  if (hits.length === 0) {
    return `No match for "${data.query}" in the knowledge base. Try different keywords, or ask the user which document they mean.`;
  }
  const lines = hits.map(
    (h) =>
      `- ${h.title} — documentId ${h.documentId} (space ${h.spaceId}, v${h.versionNo})\n  ${stripHighlight(h.snippet)}`,
  );
  return `Knowledge base hits for "${data.query}" (${hits.length}):\n${lines.join("\n")}`;
}

export function formatDocument(doc: KbDocument): string {
  const body = doc.content;
  const truncated = body.length > KB_READ_MAX_CHARS;
  const shown = truncated ? body.slice(0, KB_READ_MAX_CHARS) : body;
  const head = `# ${doc.title}\ndocumentId ${doc.id}, space ${doc.spaceId}, version ${doc.versionNo}, status ${doc.status}`;
  // 提示放在正文**前**：放在后面时它已经陪着整篇进了上下文，晚了。
  const hint =
    body.length > KB_LONG_DOC_HINT_CHARS
      ? `\nNote: this document is long (${body.length} characters, ${body.split("\n").length} lines). ` +
        "To save context, read_document with outline: true shows its headings with line ranges; then pass section or startLine/endLine to read just the part you need."
      : "";
  const tail = truncated
    ? `\n\n⚠ Truncated at ${KB_READ_MAX_CHARS} characters — the document is longer than what is shown above. Use outline: true, then section or startLine/endLine, to reach the rest.`
    : "";
  return `${head}${hint}\n\n${shown}${tail}`;
}

/** `read_document` 的按需读取选择器。优先级 outline > section > 行区间；都没有 = 整篇。 */
export interface DocumentSelector {
  outline?: boolean;
  section?: string;
  startLine?: number;
  endLine?: number;
}

function docHead(doc: KbDocument, extra: string): string {
  return `# ${doc.title}\ndocumentId ${doc.id}, space ${doc.spaceId}, version ${doc.versionNo}, ${extra}`;
}

function headingLine(h: KbHeading): string {
  const indent = "  ".repeat(h.level - 1);
  return `L${h.line}-L${h.endLine}  ${indent}${"#".repeat(h.level)} ${h.title}`;
}

/** 大纲：标题 + 行区间。无标题时直说，并给出按行读的出路。 */
export function formatOutline(doc: KbDocument): string {
  const lines = doc.content.split("\n").length;
  const outline = parseOutline(doc.content);
  const head = docHead(doc, `${lines} lines, ${doc.content.length} characters`);
  if (outline.length === 0) {
    return `${head}\n\nNo headings found in this document. Read it in ranges with startLine/endLine, or without any selector for the whole body.`;
  }
  return (
    `${head}\n\nOutline (${outline.length} headings; L<start>-L<end> are line numbers, a section includes its sub-sections):\n` +
    outline.map(headingLine).join("\n") +
    "\n\nRead one part with read_document { documentId, section: \"<heading text>\" } or { documentId, startLine, endLine }."
  );
}

/** 截断到 KB_READ_MAX_CHARS：切片也可能很长（一节几十万字），上限同整篇读。 */
function clip(text: string): string {
  return text.length > KB_READ_MAX_CHARS
    ? `${text.slice(0, KB_READ_MAX_CHARS)}\n\n⚠ Truncated at ${KB_READ_MAX_CHARS} characters — narrow the range with startLine/endLine to see the rest.`
    : text;
}

export function formatSection(doc: KbDocument, query: string): string {
  const outline = parseOutline(doc.content);
  const hit = findSection(outline, query);
  if (hit.kind === "found") {
    const h = hit.heading;
    const part = sliceLines(doc.content, h.line, h.endLine);
    return `${docHead(doc, `section "${h.title}", lines ${part.start}-${part.end} of ${part.total}`)}\n\n${clip(part.text)}`;
  }
  if (hit.kind === "ambiguous") {
    return (
      `"${query}" matches ${hit.candidates.length} headings in "${doc.title}" — pick one by its exact text, or use startLine/endLine:\n` +
      hit.candidates.map(headingLine).join("\n")
    );
  }
  const where =
    outline.length === 0
      ? "This document has no headings; use startLine/endLine."
      : `Headings in this document:\n${outline.map(headingLine).join("\n")}`;
  return `No heading matches "${query}" in "${doc.title}". ${where}`;
}

export function formatLineRange(doc: KbDocument, startLine: number, endLine: number | undefined): string {
  const total = doc.content.split("\n").length;
  if (startLine > total) {
    return `${docHead(doc, `${total} lines`)}\n\nstartLine ${startLine} is beyond the end of the document (${total} lines).`;
  }
  const part = sliceLines(doc.content, startLine, endLine ?? total);
  if (part.end < part.start) {
    return `${docHead(doc, `${total} lines`)}\n\nEmpty range: endLine must be >= startLine.`;
  }
  return `${docHead(doc, `lines ${part.start}-${part.end} of ${part.total}`)}\n\n${clip(part.text)}`;
}

/** `read_document` 的总出口：按选择器分派，没有选择器就是整篇。 */
export function formatDocumentView(doc: KbDocument, sel: DocumentSelector): string {
  if (sel.outline) return formatOutline(doc);
  if (sel.section?.trim()) return formatSection(doc, sel.section);
  if (sel.startLine !== undefined) return formatLineRange(doc, sel.startLine, sel.endLine);
  return formatDocument(doc);
}

export function formatSpaces(spaces: KbSpace[]): string {
  if (spaces.length === 0) {
    return "The signed-in user can see no knowledge base spaces. Ask the user to check their space membership in the 知识库 panel.";
  }
  const lines = spaces.map(
    (s) => `- ${s.name} — id ${s.id} (key ${s.key}, visibility ${s.visibility}${s.role ? `, your role ${s.role}` : ""})`,
  );
  return `Knowledge base spaces (${spaces.length}):\n${lines.join("\n")}`;
}

export function formatDocumentList(docs: KbDocumentSummary[]): string {
  if (docs.length === 0) {
    return "This space has no documents yet.";
  }
  const lines = docs.map((d) => {
    // 老服务端没有 kind 字段 → 按 doc 兜底（降级不能让节点看起来像文件夹）
    const kind = d.kind === "folder" ? "folder" : "doc";
    const under = d.parentId ? ` (under ${d.parentId})` : "";
    // 文件夹不显示版本号：版本对容器没有意义，显示只会让模型以为它也有正文
    const ver = kind === "folder" ? "" : `, v${d.versionNo}`;
    return `- [${kind}] ${d.title} — id ${d.id}${under}${ver}, updated ${d.updatedAt}`;
  });
  return (
    `Nodes in this space (${docs.length}) — [folder] is a container, [doc] holds the content:\n` +
    lines.join("\n")
  );
}

/** 人类可读的字节数（文案用；整数档位，不做小数）。 */
function humanBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MiB` : `${Math.round(n / 1024)} KiB`;
}

/** 超限一律「拒绝 + 给下一步」，绝不截断后照写（写进共享知识库的内容不能被悄悄剪）。 */
export function formatTooLarge(what: string, maxBytes: number): string {
  return `Refused: ${what} exceeds ${humanBytes(maxBytes)} for one tool call. Split it into smaller pieces instead.`;
}

/** 写成功回执。`verb` 是过去式动词（Created / Updated / Appended to），由调用方给。 */
export function formatSavedDocument(res: KbSaveResult, verb: string): string {
  const merged = res.merged
    ? " (merged into the current revision: same author within the merge window)"
    : "";
  return `${verb} the knowledge base document. documentId ${res.documentId}, version ${res.versionNo}${merged}.`;
}

/**
 * 删除回执。**必须写实**：这是软删（服务端只置 `deleted_at`），但界面上没有任何恢复入口，
 * 模型若以为"删错了还能找回"就会向用户打包票。标题与连带篇数都点名——只回一串 uuid，
 * 用户无法核对删掉的到底是不是他想删的那篇。
 */
export function formatDeletedDocument(title: string, documentId: string, deletedCount: number): string {
  const subs = deletedCount > 1
    ? `, together with ${deletedCount - 1} sub-document${deletedCount - 1 === 1 ? "" : "s"}`
    : "";
  return (
    `Deleted "${title}"${subs} (documentId ${documentId}). It is gone from every list, search and read path, ` +
    "and the 知识库 panel has no restore — an admin would have to recover it from the database."
  );
}

/** 导入回执。解析器的降级警告如实透出（服务端按端口/适配器范式把丢失信息放这里）。 */
export function formatIngestResult(res: KbIngestResult): string {
  const warnings = res.warnings?.length ? `\n⚠ Parser warnings: ${res.warnings.join("; ")}` : "";
  return `Imported "${res.title}" into the knowledge base. documentId ${res.documentId}, revision ${res.revisionId}, parser ${res.backend}.${warnings}`;
}

/**
 * 整篇替换的「旧文比读得到的还长」警告；空串 = 不警告。
 *
 * `read_document` 在 KB_READ_MAX_CHARS 处截断，原文比这还长时模型手里根本没有尾部——
 * 一旦照 instructions「先读、把不改的部分搬过去」的流程写回，尾部就**静默**没了。
 * 写入本身是用户批准过的（不阻断），但「你搬运的源本身是残的」必须让人看见；
 * 知识库有版本历史，回执里给出这条恢复路径。
 */
export function warnTruncatedSource(oldContent: string): string {
  if (oldContent.length <= KB_READ_MAX_CHARS) return "";
  return (
    `\n⚠ The previous body was ${oldContent.length} characters, longer than read_document can show (${KB_READ_MAX_CHARS}). ` +
    "If you carried over only what you read, the tail is now gone — check the version history in the 知识库 panel and re-apply the missing part."
  );
}
