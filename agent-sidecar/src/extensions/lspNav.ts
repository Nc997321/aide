// aide-lsp 工具的编排层：把一次工具调用变成若干 LSP 往返 + 读盘，拼成**一发就够用**的答案。
//
// 为什么要这一层（真实转录统计，2026-09-29）：09-20 之后 84 个会话里 aide-lsp 被调用 1 次，
// grep 类搜索 1667 次。模型搜代码的真实形状是：
//   grep -rn "fn our_session_workspace" -A 25 …        ← 定义 + 函数体，一发
//   grep -n "startRound\|prompt\s*=\|rewindTo" f.ts    ← 多个名字，一发
//   Grep "workspacePath|workspaceOf|activeKey"          ← 同上
// 旧工具每发只收一个名字、只回裸坐标、冷窗口空等 20–60s——每一发都比 grep 亏，
// 所以「提示词让它用」撑不过几轮。这里补齐的是**单发价值**：
//   - 定义带函数体、引用带行文本和所在函数、一次可查多个名字、文件结构带行区间；
//   - 每发有预算，语义层没答上就在**同一发里**给文本兜底（标明未验证）——最坏也不比 Grep 差。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as path from "node:path";
import type { LspQueryResponse, LspTool } from "./lspClient.js";
import {
  ambiguousText,
  containerOf,
  declaredAt,
  definitionText,
  displayPath,
  enclosingLabel,
  notAnsweredText,
  outlineText,
  referencesText,
  textFallbackText,
  type CandidateLine,
  type Loc,
  type OutlineNode,
  type RefLine,
  type TextHit,
} from "./lspFormat.js";

/** 语义查询（按名解析 + 跳转）的等待上限。超了就文本兜底——模型等不起更久。 */
export const QUERY_BUDGET_MS = 15_000;
/** 取一个文件结构（给定义配函数体、给引用标所在函数）的上限。 */
export const OUTLINE_BUDGET_MS = 6_000;
/** 文本兜底的上限。 */
export const TEXT_BUDGET_MS = 10_000;
/** 引用结果里最多给多少个文件标「所在函数」（每个文件一次 documentSymbol）。 */
export const MAX_ENCLOSING_FILES = 30;
/** 一次 lsp_symbols 最多查几个名字。 */
export const MAX_NAMES = 8;

export interface NavDeps {
  cwd: string;
  query: (tool: LspTool, args: Record<string, unknown>, timeoutMs: number) => Promise<LspQueryResponse>;
  /** 读文件文本；读不到返回 null。可注入（测试）。 */
  read?: (abs: string) => Promise<string | null>;
}

/** 位置参数（1-based），`file` 可为相对路径。 */
export interface NavArgs {
  name?: string;
  names?: string[];
  file?: string;
  line?: number;
  character?: number;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

export class LspNav {
  private readonly read: (abs: string) => Promise<string | null>;
  private readonly outlines = new Map<string, OutlineNode[]>();

  constructor(private readonly deps: NavDeps) {
    this.read = deps.read ?? readText;
  }

  // ── 工具入口 ──────────────────────────────────────────────

  /** 按名找定义（可多个名字）。每个名字：种类、位置、声明所在行；同名多义列候选。 */
  async symbols(args: NavArgs): Promise<string> {
    const names = uniq([...(args.names ?? []), ...(args.name ? [args.name] : [])]).slice(0, MAX_NAMES);
    if (names.length === 0) return "Pass `names` (or `name`): the symbol names to locate.";
    const parts = await Promise.all(names.map((n) => this.symbolOne(n)));
    return parts.join("\n\n");
  }

  /** 定义 + 函数体。 */
  async definition(args: NavArgs): Promise<string> {
    const a = await this.resolve(args);
    const resp = await this.deps.query("definition", a, QUERY_BUDGET_MS);
    const what = await this.subject(a);
    if (resp.ambiguous) return ambiguousText(what, await this.candidateLines(resp.candidates));
    const locs = locsOf(resp.results);
    if (resp.status !== "ready" || locs.length === 0) {
      if (resp.status === "ready") {
        return `No definition found for \`${what}\` at that position — the index is ready, so the position is probably not on a symbol (or the symbol comes from an external library).`;
      }
      return this.fallback(what, resp);
    }
    const blocks = await Promise.all(locs.slice(0, 3).map((l) => this.definitionBlock(l, symbolName(what))));
    const more = locs.length > 3 ? `\n\n…(${locs.length - 3} more definitions)` : "";
    return blocks.join("\n\n") + more;
  }

  /** 引用 / 实现：按文件分组，每条带行文本与所在函数。 */
  async references(tool: "references" | "implementations", args: NavArgs): Promise<string> {
    const a = await this.resolve(args);
    const resp = await this.deps.query(tool, a, QUERY_BUDGET_MS);
    const what = await this.subject(a);
    if (resp.ambiguous) return ambiguousText(what, await this.candidateLines(resp.candidates));
    if (resp.status !== "ready") {
      // 非 ready 但带回了结果：结果本身是铁证（agent_query::ok_with 的同一判据），照常展示。
      if (locsOf(resp.results).length === 0) return this.fallback(what, resp);
    }
    const label = tool === "references" ? "references" : "implementations";
    return referencesText(label, what, await this.groupRefs(locsOf(resp.results)));
  }

  /** 文件结构。 */
  async outline(args: NavArgs): Promise<string> {
    if (!args.file) return "Pass `file`: the file whose structure you want.";
    const abs = this.abs(args.file);
    const resp = await this.deps.query("outline", { file: abs }, OUTLINE_BUDGET_MS + 4_000);
    const nodes = (resp.symbols ?? []) as OutlineNode[];
    if (resp.status !== "ready" || nodes.length === 0) {
      return notAnsweredText(resp.status, displayPath(abs, this.deps.cwd), resp.error);
    }
    this.remember(abs, nodes);
    return outlineText(displayPath(abs, this.deps.cwd), nodes);
  }

  // ── 零件 ─────────────────────────────────────────────────

  private async symbolOne(name: string): Promise<string> {
    const resp = await this.deps.query("symbols", { name }, QUERY_BUDGET_MS);
    if (resp.ambiguous) return ambiguousText(name, await this.candidateLines(resp.candidates));
    const locs = locsOf(resp.results);
    if (resp.status !== "ready" || locs.length === 0) return this.fallback(name, resp);
    const rows = await Promise.all(
      locs.slice(0, 5).map(async (l) => {
        const [lines, nodes] = await Promise.all([this.lines(l.file), this.outlineOf(l.file)]);
        const node = nodes ? declaredAt(nodes, l.line, symbolName(name)) : null;
        const container = node && nodes ? containerOf(nodes, node) : null;
        const kind = node ? `${kindOf(node)}${container ? ` in ${container}` : ""}` : "defined";
        const span = node && node.end_line > node.start_line ? `, lines ${node.start_line}-${node.end_line}` : "";
        const text = lines?.[l.line - 1]?.trim();
        return `\`${name}\` — ${kind} · ${this.rel(l.file)}:${l.line}:${l.column}${span}${text ? `\n    ${text}` : ""}`;
      }),
    );
    return rows.join("\n");
  }

  private async definitionBlock(l: Loc, name: string | undefined): Promise<string> {
    const [lines, nodes] = await Promise.all([this.lines(l.file), this.outlineOf(l.file)]);
    const node = nodes ? declaredAt(nodes, l.line, name) ?? declaredAt(nodes, l.line) : null;
    const container = node && nodes ? containerOf(nodes, node) : null;
    return definitionText(this.rel(l.file), l, lines, node, container);
  }

  private async groupRefs(locs: Loc[]): Promise<Array<{ rel: string; refs: RefLine[] }>> {
    const byFile = new Map<string, Loc[]>();
    for (const l of locs) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l]);
    const files = [...byFile.keys()];
    return Promise.all(
      files.map(async (file, i) => {
        const [lines, nodes] = await Promise.all([
          this.lines(file),
          i < MAX_ENCLOSING_FILES ? this.outlineOf(file) : Promise.resolve(null),
        ]);
        const refs = byFile
          .get(file)!
          .sort((a, b) => a.line - b.line || a.column - b.column)
          .map((l) => ({
            line: l.line,
            column: l.column,
            text: lines?.[l.line - 1] ?? "",
            enclosing: nodes ? enclosingLabel(nodes, l.line) : null,
          }));
        return { rel: this.rel(file), refs };
      }),
    );
  }

  /** 语义层没答上：有名字就在同一发里做文本兜底，否则如实说没答上。 */
  private async fallback(what: string, resp: LspQueryResponse): Promise<string> {
    const name = symbolName(what);
    if (resp.status === "untrusted" || !name || !IDENT.test(name)) {
      return notAnsweredText(resp.status, what, resp.error);
    }
    const text = await this.deps.query("text", { name }, TEXT_BUDGET_MS);
    if (!text.ok) return notAnsweredText(resp.status, what, resp.error);
    const hits = ((text.matches ?? []) as TextHit[]).map((h) => ({ ...h, file: displayPath(h.file, this.deps.cwd) }));
    return textFallbackText(name, reasonOf(resp), hits, !!text.truncated);
  }

  private async candidateLines(raw: unknown[] | undefined): Promise<CandidateLine[]> {
    const cands = (raw ?? []) as Array<{ file_path?: string; line?: number; column?: number; kind?: number }>;
    return Promise.all(
      cands
        .filter((c) => c.file_path)
        .map(async (c) => {
          const lines = await this.lines(c.file_path!);
          const line = c.line ?? 1;
          return {
            rel: this.rel(c.file_path!),
            line,
            column: c.column ?? 1,
            kind: c.kind,
            text: lines?.[line - 1] ?? null,
          };
        }),
    );
  }

  /** 查询说的是谁：给了名字就是名字；给了坐标就读出那个位置上的标识符。 */
  private async subject(a: Record<string, unknown>): Promise<string> {
    if (typeof a.name === "string" && a.name) return a.name;
    if (typeof a.file === "string" && typeof a.line === "number") {
      const lines = await this.lines(a.file);
      const word = lines ? identifierAt(lines[a.line - 1] ?? "", Number(a.character ?? 1)) : null;
      if (word) return word;
      return `${this.rel(a.file)}:${a.line}:${a.character ?? 1}`;
    }
    return "";
  }

  /** 把模型给的参数补成后端吃得下的形状。模型常只记得一半——为补另一半再 Read 一轮，
   *  就是又一个退回 grep 的理由，所以这里替它补：
   *  - `file` 可相对；
   *  - `{file, line}` 没给列：取该行里 `name` 的位置，否则第一个非关键字标识符；
   *  - `{name, file}` 没给行：在该文件里找这个名字的声明（结构优先，文本兜底）——
   *    同名多义时这就是消歧，不必先吃一发「N 个候选」。 */
  private async resolve(args: NavArgs): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (args.name) out.name = args.name;
    if (!args.file) return out;
    const file = this.abs(args.file);
    out.file = file;
    const name = args.name ? symbolName(args.name) : undefined;
    if (typeof args.line === "number") {
      out.line = args.line;
      if (typeof args.character === "number") {
        out.character = args.character;
      } else {
        const lines = await this.lines(file);
        out.character = columnOf(lines?.[args.line - 1] ?? "", name);
      }
      delete out.name;
      return out;
    }
    if (!name) return out;
    const pos = await this.findInFile(file, name);
    if (pos) {
      delete out.name;
      Object.assign(out, pos);
    }
    return out;
  }

  /** 名字在某文件里的声明位置：结构里同名的最外层声明；结构拿不到就取文本里的声明行
   *  （没有声明行才取第一处整词出现）。**返回的列必须落在名字本身上**——落在 `async` /
   *  `pub` / 文档注释上，查引用问的就是那个词（真机 2026-09-30：`sendMessage` 查成了
   *  `async`，`start_run` 查成了注释里的 `manual`，后者回的是「确认没有引用」）。 */
  private async findInFile(file: string, name: string): Promise<{ line: number; character: number } | null> {
    const [nodes, lines] = await Promise.all([this.outlineOf(file), this.lines(file)]);
    const node = nodes
      ?.filter((n) => n.name === name || n.name.endsWith(`.${name}`))
      .sort((a, b) => a.depth - b.depth)[0];
    if (node) {
      if (!lines || identifierAt(lines[node.line - 1] ?? "", node.column) === name) {
        return { line: node.line, character: node.column };
      }
      // 结构给的是声明起点（或把文档注释算进范围）：在该声明的范围里找名字本身。
      const hit = findName(lines, name, node.line, Math.max(node.line, node.end_line ?? node.line));
      return hit ?? { line: node.line, character: node.column };
    }
    if (!lines) return null;
    return findDeclaration(lines, name) ?? findName(lines, name, 1, lines.length);
  }

  private async outlineOf(abs: string): Promise<OutlineNode[] | null> {
    const text = await this.read(abs);
    if (text == null) return null;
    const key = `${abs}\0${digest(text)}`;
    const hit = this.outlines.get(key);
    if (hit) return hit;
    const resp = await this.deps.query("outline", { file: abs }, OUTLINE_BUDGET_MS);
    const nodes = resp.status === "ready" ? ((resp.symbols ?? []) as OutlineNode[]) : null;
    if (nodes && nodes.length) this.cache(key, nodes);
    return nodes;
  }

  private remember(abs: string, nodes: OutlineNode[]): void {
    void this.read(abs).then((t) => t != null && this.cache(`${abs}\0${digest(t)}`, nodes));
  }

  private cache(key: string, nodes: OutlineNode[]): void {
    if (this.outlines.size >= 64) this.outlines.delete(this.outlines.keys().next().value!);
    this.outlines.set(key, nodes);
  }

  private async lines(abs: string): Promise<string[] | null> {
    const t = await this.read(abs);
    return t == null ? null : t.split(/\r?\n/);
  }

  private abs(file: string): string {
    return path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? file : path.resolve(this.deps.cwd, file);
  }

  private rel(abs: string): string {
    return displayPath(abs, this.deps.cwd);
  }
}

function wordRe(name: string): RegExp {
  return new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
}

/** `[from, to]` 行（1-based，含两端）里名字的第一处整词出现。 */
export function findName(
  lines: string[],
  name: string,
  from: number,
  to: number,
): { line: number; character: number } | null {
  const re = wordRe(name);
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) {
    const m = re.exec(lines[i - 1]);
    if (m) return { line: i, character: m.index + m[1].length + 1 };
  }
  return null;
}

const DECL_BEFORE =
  "(?:fn|function|class|struct|enum|trait|interface|type|const|let|var|def|mod|impl|func|val|object)";

/** 文本里名字的声明行（关键字 + 名字，或行首 `名字(… {` 形状的方法声明）。 */
export function findDeclaration(lines: string[], name: string): { line: number; character: number } | null {
  const n = name.replace(/\$/g, "\\$");
  const keyword = new RegExp(`\\b${DECL_BEFORE}\\*?\\s+${n}(?![\\w$])`);
  const method = new RegExp(
    `^\\s*(?:(?:pub(?:\\([^)]*\\))?|public|private|protected|static|async|override|readonly)\\s+)*${n}\\s*(?:<[^>]*>)?\\(.*\\{\\s*$`,
  );
  for (const re of [keyword, method]) {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      const hit = findName([lines[i]], name, 1, 1);
      if (hit) return { line: i + 1, character: hit.character };
    }
  }
  return null;
}

/** 位置处的标识符（1-based 列）。列落在标识符之外时取该行第一个标识符。 */
export function identifierAt(lineText: string, column: number): string | null {
  const re = /[A-Za-z_$][\w$]*/g;
  let first: string | null = null;
  for (let m = re.exec(lineText); m; m = re.exec(lineText)) {
    first ??= m[0];
    const start = m.index + 1;
    if (column >= start && column <= start + m[0].length) return m[0];
  }
  return first;
}

const KEYWORDS = new Set([
  "pub", "fn", "async", "await", "const", "let", "var", "function", "export", "default", "class",
  "struct", "enum", "trait", "impl", "interface", "type", "def", "return", "static", "public",
  "private", "protected", "readonly", "mod", "use", "import", "from", "new", "crate", "self", "super",
]);

/** 一行里该查的列（1-based）：`name` 的整词位置，否则第一个非关键字标识符，都没有则 1。 */
export function columnOf(lineText: string, name: string | undefined): number {
  const re = /[A-Za-z_$][\w$]*/g;
  let firstPlain: number | null = null;
  for (let m = re.exec(lineText); m; m = re.exec(lineText)) {
    if (name && m[0] === name) return m.index + 1;
    if (firstPlain === null && !KEYWORDS.has(m[0])) firstPlain = m.index + 1;
  }
  return firstPlain ?? 1;
}

/** `LspManager::get` / `Foo.bar` → 末段裸名（与 Rust 侧 symbol_query_name 同义，再多认 `.`）。 */
export function symbolName(what: string): string | undefined {
  const last = what.split("::").pop()?.split(".").pop();
  return last && IDENT.test(last) ? last : undefined;
}

/** Rust 侧 QueryResult（嵌套 symbol.file/line/column）→ Loc。缺路径的条目丢弃。 */
export function locsOf(results: unknown[] | undefined): Loc[] {
  return ((results ?? []) as Array<{ symbol?: { file?: string; line?: number; column?: number } }>)
    .filter((r) => r.symbol?.file)
    .map((r) => ({ file: r.symbol!.file!, line: r.symbol!.line ?? 1, column: r.symbol!.column ?? 1 }));
}

function kindOf(node: OutlineNode): string {
  const words: Record<number, string> = { 6: "method", 12: "function", 5: "class", 23: "struct", 11: "interface", 10: "enum" };
  return words[node.kind] ?? (node.detail ? node.detail.split(/\s/)[0] : "symbol");
}

function reasonOf(resp: LspQueryResponse): string {
  if (resp.timedOut || resp.status === "timeout") return "it did not finish within the time budget";
  if (resp.status === "indexing") return "it is still indexing";
  if (resp.status === "no_server") return "no language server for this code";
  return `status: ${resp.status}${resp.error ? ` — ${resp.error}` : ""}`;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

function digest(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

async function readText(abs: string): Promise<string | null> {
  try {
    const buf = await readFile(abs);
    if (buf.length > 2_000_000 || buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}
