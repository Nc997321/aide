// aide-lsp 结果的文本化（纯函数，不碰 IO）。**这个模块是「空 ≠ 没有」红线在模型侧的最后一关。**
//
// 设计目标（2026-09-29 按真实转录重写）：**每一发都要比 grep 值**。agent 退回 grep 不是
// 因为不知道工具在，是因为旧输出只有裸坐标（`/c%3A/…:20:10`），还要再 Read 一轮才看得到
// 东西；grep 一发就带着行文本和 `-A 25` 的上下文。所以这里的每种输出都自带代码：
//   - 引用：按文件分组、每条带行文本 + **所在函数**（grep 给不了的那一列）；
//   - 定义：带**整个函数体**（Read 的 cat -n 格式，模型最熟的形状）；
//   - 结构：一个文件的声明树 + 行区间，替代「整文件 Read 一遍找方向」。
//
// 状态词与 Rust 侧 src-tauri/src/lsp/agent_status.rs 的 as_str() 必须逐字一致：
// 漂移的后果是模型读到未知状态走兜底分支——**静默降级**，不报错。

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

/** 整段输出的字节上限。grep 的输出从不小于这个量级；旧版 1.8KB 的上限让一次引用查询
 *  装不下一个中等符号，模型只好再去 grep。 */
export const MAX_OUTPUT_BYTES = 12_000;

/** LSP SymbolKind → 词。 */
const KIND_WORDS: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
  12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null",
  22: "enum member", 23: "struct", 24: "event", 25: "operator", 26: "type parameter",
};

export function kindWord(kind: number | undefined): string {
  return (kind && KIND_WORDS[kind]) || "symbol";
}

/** 函数形的 kind：它们的子节点是局部变量，不是结构。 */
const CALLABLE_KINDS = new Set([6, 9, 12]);

/** agent_nav.rs 的 OutlineNode（serde 蛇形字段名）。 */
export interface OutlineNode {
  name: string;
  kind: number;
  detail?: string;
  line: number;
  column: number;
  start_line: number;
  end_line: number;
  depth: number;
}

/** 一处位置（绝对路径，1-based）。 */
export interface Loc {
  file: string;
  line: number;
  column: number;
}

/** 绝对路径 → 相对工作区根的显示路径（正斜杠）。不在根下 → 原样（正斜杠）。
 *  比较大小写不敏感：tsserver 回小写盘符 `c:/`，工作区根是 `C:\`。 */
export function displayPath(abs: string, root: string): string {
  const a = abs.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (r && a.toLowerCase().startsWith(r.toLowerCase() + "/")) return a.slice(r.length + 1);
  return a;
}

/** 包含某行的声明链（外层 → 内层）。 */
export function containingChain(nodes: OutlineNode[], line: number): OutlineNode[] {
  return nodes
    .filter((n) => n.start_line <= line && line <= n.end_line)
    .sort((a, b) => a.depth - b.depth || b.end_line - b.start_line - (a.end_line - a.start_line));
}

/** 「在哪个函数里」：包含链最内两层的名字（`LspManager › get`）。顶层代码 → null。 */
export function enclosingLabel(nodes: OutlineNode[], line: number): string | null {
  const chain = containingChain(nodes, line);
  if (chain.length === 0) return null;
  return chain.slice(-2).map((n) => n.name).join(" › ");
}

/** 在这一行**声明**的节点（名字就在这一行；多个时取范围最小的）。 */
export function declaredAt(nodes: OutlineNode[], line: number, name?: string): OutlineNode | null {
  const hits = nodes
    .filter((n) => n.line === line && (!name || n.name === name || n.name.endsWith(`.${name}`)))
    .sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line));
  return hits[0] ?? null;
}

/** 声明所在的外层（`class Foo` 里的方法 → `Foo`）。 */
export function containerOf(nodes: OutlineNode[], node: OutlineNode): string | null {
  const chain = containingChain(nodes, node.line).filter((n) => n !== node && n.depth < node.depth);
  return chain.length ? chain[chain.length - 1].name : null;
}

/** 文件结构。局部变量（函数体里的声明）不算结构，略去；每行带行区间，模型据此
 *  `Read offset/limit` 精确取段，而不是整文件读。 */
export function outlineText(rel: string, nodes: OutlineNode[], maxEntries = 300): string {
  const shown: string[] = [];
  const stack: OutlineNode[] = [];
  let skipped = 0;
  for (const n of nodes) {
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    const inCallable = stack.some((s) => CALLABLE_KINDS.has(s.kind));
    stack.push(n);
    if (inCallable) continue;
    if (shown.length >= maxEntries) {
      skipped++;
      continue;
    }
    const detail = n.detail && n.detail.length <= 80 ? `  — ${n.detail}` : "";
    const span = n.end_line > n.start_line ? `${n.start_line}-${n.end_line}` : `${n.line}`;
    shown.push(`${"  ".repeat(n.depth)}${kindWord(n.kind)} ${n.name}  L${span}${detail}`);
  }
  const more = skipped ? `\n…(${skipped} more declarations not shown)` : "";
  return `Structure of ${rel} (${shown.length + skipped} declarations; L<start>-<end> are line ranges):\n${shown.join("\n")}${more}`;
}

/** 一段源码，Read 的 `cat -n` 格式（行号 + tab）。 */
export function numberedLines(lines: string[], from: number, to: number): string {
  const out: string[] = [];
  for (let n = from; n <= to && n <= lines.length; n++) out.push(`${n}\t${lines[n - 1]}`);
  return out.join("\n");
}

/** 定义体的最大行数。再长就给出续读指令（Read offset=…），不整段倒进上下文。 */
export const MAX_BODY_LINES = 80;

/** 定义：头行 + 函数体（没有结构信息时退化为定义行附近的一段）。 */
export function definitionText(
  rel: string,
  loc: Loc,
  lines: string[] | null,
  node: OutlineNode | null,
  container: string | null,
): string {
  const what = node ? `${kindWord(node.kind)} ${container ? `${container}.` : ""}${node.name}` : "definition";
  const head = `${what} — ${rel}:${loc.line}:${loc.column}`;
  if (!lines) return `${head}\n(file could not be read)`;
  const from = node ? Math.min(node.start_line, loc.line) : Math.max(1, loc.line - 3);
  const end = node ? node.end_line : Math.min(lines.length, loc.line + 25);
  const to = Math.min(end, from + MAX_BODY_LINES - 1);
  const more =
    to < end
      ? `\n…(${end - to} more lines — Read ${rel} with offset=${to + 1} to continue)`
      : "";
  return `${head}\n${numberedLines(lines, from, to)}${more}`;
}

/** 一条引用（显示用）。 */
export interface RefLine {
  line: number;
  column: number;
  text: string;
  enclosing: string | null;
}

/** 按文件分组的引用。每条：行:列、所在函数、行文本——grep 的那一列加上它给不了的那一列。 */
export function referencesText(
  label: string,
  what: string,
  groups: Array<{ rel: string; refs: RefLine[] }>,
): string {
  const total = groups.reduce((s, g) => s + g.refs.length, 0);
  if (total === 0) {
    return `No ${label} of \`${what}\` — the language server's index is ready, so this is a confirmed negative (not a missing answer). Note: files outside the language project (e.g. excluded test files) are not searched.`;
  }
  const head = `${total} ${label} of \`${what}\` in ${groups.length} file${groups.length === 1 ? "" : "s"} (compiler-precise: no comments, strings or same-named symbols):`;
  const body = groups
    .map((g) => {
      const rows = g.refs.map((r) => {
        const where = r.enclosing ? `  [in ${r.enclosing}]` : "";
        return `  ${r.line}:${r.column}${where}  ${clip(r.text.trim(), 140)}`;
      });
      return `${g.rel}\n${rows.join("\n")}`;
    })
    .join("\n");
  return clampOutput(`${head}\n${body}`, total);
}

/** 一条文本命中（agent_nav.rs 的 TextHit，路径已相对化）。 */
export interface TextHit {
  file: string;
  line: number;
  column: number;
  text: string;
}

/** 语义层没答上时的兜底：**同一发里**给出和 Grep 一样的东西，并如实标注它不是引用。
 *  这是让模型「调一次最坏也不亏」的那一半——旧版这里只有一句「重试或去用 Grep」。 */
export function textFallbackText(
  what: string,
  reason: string,
  hits: TextHit[],
  truncated: boolean,
): string {
  const head = `The language server could not answer this yet (${reason}). Plain-text occurrences of \`${what}\` instead — UNVERIFIED: they may include comments, strings and unrelated same-named symbols, and an absence here is not proof:`;
  if (hits.length === 0) return `${head}\n  (none in source files)`;
  const byFile = new Map<string, TextHit[]>();
  for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  const body = [...byFile.entries()]
    .map(([f, hs]) => `${f}\n${hs.map((h) => `  ${h.line}:${h.column}  ${clip(h.text, 140)}`).join("\n")}`)
    .join("\n");
  const more = truncated ? "\n…(more matches not shown — narrow with Grep)" : "";
  return clampOutput(`${head}\n${body}${more}`, hits.length);
}

/** 非 ready 且没有名字可做文本兜底时的文案。**一律不用肯定句说「没有」**，一律给 Grep 退路。 */
export function notAnsweredText(status: string, what: string, detail?: string): string {
  const subject = what ? ` for \`${what}\`` : "";
  const d = detail?.trim() ? ` Detail: ${detail.trim()}` : "";
  switch (status) {
    case "indexing":
      return `The query${subject} was not answered — the language server is still building its index. An empty result does NOT mean the symbol is unused; nobody looked yet.${d} Use Grep for now and say the result is unverified.`;
    case "no_symbol":
      // 句式：**不许用 "No ..." 开头**——那是 ready 形态（「已确认的否定」）的专属句式。
      return `Name search found nothing${subject}. That is not a confirmed negative — check the spelling, and cross-check with Grep before relying on the absence.${d}`;
    case "no_server":
      return `There is no language server for this file type, so the query${subject} was not answered. Use Grep.${d}`;
    case "untrusted":
      return `This workspace is not trusted, so LSP is disabled and the query${subject} was not answered. Use Grep.`;
    case "timeout":
    case "gone":
      return `The language server did not complete the request${subject}. Treat any absence of results as unverified — confirm with Grep.${d}`;
    default:
      return `The LSP query${subject} failed (status: ${status}).${d} Treat the result as unverified and use Grep.`;
  }
}

/** 同名多义的候选（显示用）。 */
export interface CandidateLine {
  rel: string;
  line: number;
  column: number;
  kind: number | undefined;
  text: string | null;
}

/** 同名多义：列候选 + 明确要求模型自己定，**不替它选**（spec：不假装唯一）。 */
export function ambiguousText(what: string, cands: CandidateLine[]): string {
  const rows = cands.map(
    (c) => `  ${kindWord(c.kind)}  ${c.rel}:${c.line}:${c.column}${c.text ? `  ${clip(c.text.trim(), 120)}` : ""}`,
  );
  return clampOutput(
    `${cands.length} symbols are named \`${what}\` — the name alone cannot say which one you mean. Pick one and re-query with its position, e.g. lsp_references {file, line, character} (lsp_definition takes a position too):\n${rows.join("\n")}`,
    cands.length,
  );
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 截断要如实说——结果进上下文，超预算就是每一轮的长期成本。 */
export function clampOutput(text: string, total: number): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  const cut = Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  const lastNl = cut.lastIndexOf("\n");
  return `${lastNl > 0 ? cut.slice(0, lastNl) : cut}\n…(truncated: ${total} results total — narrow the query)`;
}
