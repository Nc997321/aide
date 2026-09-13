// 知识库工具返回文本的唯一产地（纯函数，单测直接覆盖）。
//
// 红线：失败也返回**文本**，永不 throw、永不 isError——工具报错会让 agent 纠结，
// 文本提示让它自然换路（codegraphTools.ts:50 先例）。每条失败文案都要写清「下一步」。
import type {
  KbDocument,
  KbDocumentSummary,
  KbFailure,
  KbSearchResult,
  KbSpace,
} from "./client.js";

/** 未配置 / 已登出时的引导文本（工具恒挂，未登录也有话可说——设计 spec §5.1）。 */
export const KB_NOT_CONNECTED_TEXT =
  "The knowledge base is not connected — no credentials are saved for this desktop. " +
  "Ask the user to sign in from the 知识库 panel, then retry (no new session is needed).";

/** `read_document` 输出上限：超出截断并显式注明。 */
export const KB_READ_MAX_CHARS = 100_000;

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
      return `The knowledge base rejected the request: ${f.message}`;
    case "server":
      return `The knowledge base returned a server error (${f.status}). Retry once; if it persists, tell the user to check the knowledge base service.`;
    case "network":
      return `Could not reach the knowledge base at ${f.baseUrl} (${f.detail}). Retry once; if it persists, check that the service is running and that the address in the 知识库 panel is right.`;
    case "timeout":
      return "The knowledge base request timed out. Retry once; if it keeps timing out, tell the user the service may be overloaded.";
    case "bad_response":
      return `The knowledge base returned an unexpected response: ${f.detail}`;
  }
}

export function formatSearchHits(data: KbSearchResult): string {
  const hits = data.hits ?? [];
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
  const body = doc.content ?? "";
  const truncated = body.length > KB_READ_MAX_CHARS;
  const shown = truncated ? body.slice(0, KB_READ_MAX_CHARS) : body;
  const head = `# ${doc.title}\ndocumentId ${doc.id}, space ${doc.spaceId}, version ${doc.versionNo}, status ${doc.status}`;
  const tail = truncated
    ? `\n\n⚠ Truncated at ${KB_READ_MAX_CHARS} characters — the document is longer than what is shown above.`
    : "";
  return `${head}\n\n${shown}${tail}`;
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
  const lines = docs.map(
    (d) =>
      `- ${d.title} — id ${d.id}${d.parentId ? ` (under ${d.parentId})` : ""}, v${d.versionNo}, updated ${d.updatedAt}`,
  );
  return `Documents in this space (${docs.length}):\n${lines.join("\n")}`;
}
