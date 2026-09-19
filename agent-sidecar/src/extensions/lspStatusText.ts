// LSP 工具结果的文本化。**这个模块是「空 ≠ 没有」红线在模型侧的最后一关。**
//
// 状态词与 Rust 侧 src-tauri/src/lsp/agent_status.rs 的 as_str() 必须逐字一致：
// 漂移的后果是模型读到未知状态走兜底分支——**静默降级**，不报错。改一边就要改
// 另一边，本文件的 LSP_STATUS_WORDS 与测试一起钉住这八个词。
import type { LspQueryResponse, LspTool } from "./lspClient.js";

/** 与 agent_status.rs 的 as_str() 逐字一致。测试钉住。 */
export const LSP_STATUS_WORDS = [
  "ready",
  "indexing",
  "no_symbol",
  "no_server",
  "untrusted",
  "timeout",
  "gone",
  "error",
] as const;

/** 正文字节上限。留出余量给截断说明，保证整段文本不超过 2KB。 */
const MAX_BODY_BYTES = 1800;

const LABELS: Record<LspTool, string> = {
  symbols: "symbols",
  references: "references",
  definition: "definition",
  implementations: "implementations",
  warm: "results",
};

export function formatLspResponse(
  tool: LspTool,
  resp: LspQueryResponse,
  args: Record<string, unknown>,
): string {
  const what = String(args.name ?? args.file ?? "");
  // `no_symbol` 也是 ok:false——但它**不是**「未就绪」，见 notReadyText 的分支。
  return resp.status === "ready" ? okText(tool, resp, what) : notReadyText(resp, what);
}

/** 非 ready：**一律不用肯定句说「没有」**，一律给 Grep 退路。 */
function notReadyText(resp: LspQueryResponse, what: string): string {
  const subject = what ? ` for \`${what}\`` : "";
  switch (resp.status) {
    case "indexing":
      return `The language server is still building its index, so the ${subject.trim() || "query"} was not answered. An empty result now does NOT mean the reference does not exist — it means nobody looked yet. Retry in ~30s, or use Grep and say the result is unverified.`;
    case "no_symbol":
      return `The index answered, but it has no symbol${subject}. Check the spelling, or drop any \`Type::\` qualifier and search the bare name. If you expected a hit, cross-check with Grep and say the result is unverified.`;
    case "no_server":
      // 刻意不用 "No ..." 开头：那个句式是 ready 形态的专属（见测试的判据），
      // 混用会让「已确认的否定」与「没能回答」在措辞上无法区分。
      return `There is no language server configured for this workspace, so the${subject} query was not answered. Use Grep.`;
    case "untrusted":
      return `This workspace is not trusted, so LSP is disabled and the${subject} query was not answered. Use Grep.`;
    case "timeout":
    case "gone":
      return `The language server did not complete the${subject} request. Treat any absence of results as unverified — confirm with Grep before relying on it.`;
    default:
      return `LSP query${subject} failed (status: ${resp.status})${resp.error ? `: ${resp.error}` : ""}. Treat the result as unverified and use Grep.`;
  }
}

/** 结果条目的真实形状（`QueryResult.symbol`，见 src-tauri/src/lsp/protocol.rs 的
 *  `location_to_query_result`）。**嵌套一层**——初版按扁平的 `file`/`line`/`column`
 *  读，真机输出全是 `undefined:undefined:1`。夹具照假设写 = 测试只验证了假设。 */
interface QueryResultLike {
  symbol?: { file?: string; line?: number; column?: number };
}

/** 只有 status=ready 才允许说「没有」。 */
function okText(tool: LspTool, resp: LspQueryResponse, what: string): string {
  if (resp.ambiguous) return ambiguousText(what, (resp.candidates ?? []) as SymbolCandidateLike[]);

  const results = (resp.results ?? []) as QueryResultLike[];
  if (results.length === 0) {
    return `No ${LABELS[tool]} found for \`${what}\` — the language server's index is ready, so this is a confirmed negative (not a missing answer).`;
  }
  const lines = results.map((r) => {
    const sym = r.symbol;
    // 读不到路径 = 契约漂移。**如实说出**，不要打印 undefined 让模型对着一堆
    // `undefined:undefined:1` 自己猜——那正是这次踩的坑。
    if (!sym?.file) return "  (result missing path — protocol drift, report it)";
    return `  ${sym.file}:${sym.line ?? 1}:${sym.column ?? 1}`;
  });
  return `${results.length} ${LABELS[tool]} for \`${what}\`:\n${clamp(lines.join("\n"), results.length)}`;
}

/** 歧义候选是 `SymbolCandidate`（**扁平**：`file_path`/`line`/`column`/`lang`），
 *  与 `results` 的 `QueryResult`（嵌套 `symbol.file`）**不是同一个形状**——同一个
 *  payload 里并存两种，别互相套用（这里踩过一次，测试抓住了）。 */
interface SymbolCandidateLike {
  name?: string;
  file_path?: string;
  line?: number;
  column?: number;
  lang?: string;
}

/** 同名多义：列候选 + 明确要求模型自己定，**不替它选**（spec：不假装唯一）。 */
function ambiguousText(what: string, cands: SymbolCandidateLike[]): string {
  const lines = cands.map((c) =>
    c.file_path ? `  ${c.file_path}:${c.line ?? 1}:${c.column ?? 1}` : "  (candidate missing path)"
  );
  return `${cands.length} symbols named \`${what}\` — which one you mean cannot be decided from the name alone. Read the candidates and re-query with an explicit {file, line, character} for the one you want:\n${clamp(lines.join("\n"), cands.length)}`;
}

/** 截断要如实说——结果进上下文，超预算就是每一轮的长期成本。 */
function clamp(body: string, total: number): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES) return body;
  const cut = Buffer.from(body, "utf8").subarray(0, MAX_BODY_BYTES).toString("utf8");
  return `${cut}\n…(truncated: ${total} results total)`;
}
