// grep 顺带作答：agent 用 Grep / Bash 里的 grep·rg 搜**代码标识符**时，在结果后面附上
// 语言服务器的答案（定义在哪、真实引用几处、同名有几个）。
//
// 为什么不只靠工具（真实转录，2026-09-29）：09-20 之后 84 个会话，grep 类搜索 1667 次，
// aide-lsp 1 次。**模型选工具靠习惯**，说明书翻转不了一个一天用上百次的习惯；
// 用户手动要求时它用几次，随后又回到 grep。与其继续说服它换工具，不如把语义答案送到
// 它**已经在用**的地方：它搜 `run_jump`，结果后面就写着「函数，定义在 …:548，2 处真实引用」
// ——不管它选不选 aide-lsp，这部分价值都已经到手；需要细节时，那一行也告诉它该调哪个工具。
//
// 纪律：
//   - **只在语言服务器热了之后**（`isLspWarm`）：冷窗口里给每次 grep 加几秒等待，
//     是把 agent 推离一切搜索的代价。
//   - 只说**确定的事**：非 ready 的答案一律不附（「没答上」写进 grep 结果只是噪音）。
//   - 预算硬顶 `GLANCE_BUDGET_MS`，超时就什么都不附——宁缺毋滥。
//   - 管道里读 stdin 的 grep（`cmd | grep FAIL`）是在过滤输出，不是搜代码，不附。
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { LspQueryResponse, LspTool } from "./lspClient.js";
import { declaredAt, displayPath, kindWord, type Loc, type OutlineNode } from "./lspFormat.js";
import { locsOf } from "./lspNav.js";

/** 整个附注的等待上限。命中实测 ~0.3s；**没命中的代价必须小**——评测（2026-09-30，
 *  DeepSeek，真实任务）里预算 5s 时，112 次「索引里没有这个名字」各白等 ~3.3s，整轮慢了一半。
 *  超时不白费：后端照样按文本递文件（agent_query 的两段式），那个工程下次就是热的。 */
export const GLANCE_BUDGET_MS = 1_500;
/** 同一会话里没命中几次就不再问（注释 / 字符串里的词、别的语言的名字）。 */
export const MAX_MISSES = 2;
/** 一次搜索最多看几个标识符。 */
export const MAX_GLANCE_IDENTS = 3;

export interface GlanceDeps {
  cwd: string;
  query: (tool: LspTool, args: Record<string, unknown>, timeoutMs: number) => Promise<LspQueryResponse>;
  isWarm: () => boolean;
}

/** 标识符「像代码符号」：带下划线、驼峰、或多峰帕斯卡；≥4 个字符。
 *  `count` / `text` / `unchanged` 这类普通词不算——它们在代码里当然也可能是符号，但按名查
 *  回来的是一大串同名物，附上去只是噪音。 */
export function looksLikeCodeSymbol(tok: string): boolean {
  if (tok.length < 4 || !/^[A-Za-z_$][\w$]*$/.test(tok)) return false;
  if (/_/.test(tok.slice(1, -1))) return true; // snake_case / SCREAMING_CASE
  return /[a-z][A-Z]/.test(tok); // camelCase / 多峰 PascalCase
}

const DEF_KEYWORDS = new Set([
  "fn", "pub", "async", "function", "class", "struct", "enum", "trait", "impl", "interface",
  "type", "def", "const", "let", "var", "export", "static", "mod", "crate", "self",
]);

/** 正则模式里的候选标识符（按 `|` / `\|` 拆分支；转义序列与关键字剔除）。 */
export function identifiersInPattern(pattern: string): string[] {
  const cleaned = pattern
    .replace(/\\[bBwWsSdD<>]/g, " ") // 词边界 / 字符类
    .replace(/\\\|/g, "|")
    .replace(/\\./g, " ");
  const out: string[] = [];
  for (const m of cleaned.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const t = m[0];
    if (DEF_KEYWORDS.has(t) || !looksLikeCodeSymbol(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const NON_CODE = /\.(md|mdx|txt|log|json|jsonl|ya?ml|toml|lock|csv|html?|css|scss|output|xml|ini|env)$/i;

/** Grep 工具输入里的标识符。glob/type/path 明确指向非代码文件时不附。 */
export function identifiersFromGrepTool(input: Record<string, unknown>): string[] {
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  const targets = [input.glob, input.path].filter((v): v is string => typeof v === "string");
  if (targets.some((t) => NON_CODE.test(t))) return [];
  return identifiersInPattern(pattern);
}

/** Bash 命令里 grep / rg / git grep 的搜索模式里的标识符。 */
export function identifiersFromBash(command: string): string[] {
  const out: string[] = [];
  for (const seg of pipelineHeads(command)) {
    const words = shellWords(seg);
    let i = 0;
    if (words[0] === "git" && words[1] === "grep") i = 2;
    else if (/^(grep|egrep|fgrep|rg)$/.test(words[0] ?? "")) i = 1;
    else continue;
    const { pattern, paths } = grepArgs(words.slice(i));
    if (!pattern || paths.some((p) => NON_CODE.test(p))) continue;
    for (const id of identifiersInPattern(pattern)) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 值紧跟在后面的 grep/rg 选项（`-A 25`、`--include x`、`-g x`…）。 */
const VALUE_FLAGS = new Set([
  "-A", "-B", "-C", "-m", "-g", "-t", "-T", "-f", "--include", "--exclude", "--glob", "--type",
  "--max-count", "--context", "--after-context", "--before-context", "--exclude-dir", "-d", "-D",
]);

function grepArgs(args: string[]): { pattern: string | null; paths: string[] } {
  let pattern: string | null = null;
  const rest: string[] = [];
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-e" || a === "--regexp") {
      pattern ??= args[++i] ?? null;
    } else if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if ((a === "--include" || a === "-g" || a === "--glob") && v) paths.push(v);
    } else if (/^--(include|glob)=/.test(a)) {
      paths.push(a.split("=")[1]);
    } else if (a.startsWith("-")) {
      continue;
    } else {
      rest.push(a);
    }
  }
  if (pattern === null) pattern = rest.shift() ?? null;
  paths.push(...rest);
  return { pattern, paths };
}

/** 每条流水线的第一段（后续段读 stdin，是在过滤输出）。按 ; && || 换行切分流水线。 */
function pipelineHeads(command: string): string[] {
  const heads: string[] = [];
  for (const pipeline of splitOutsideQuotes(command, /^(;|&&|\|\||\n)/)) {
    const first = splitOutsideQuotes(pipeline, /^\|(?!\|)/)[0];
    if (first?.trim()) heads.push(first.trim());
  }
  return heads;
}

function splitOutsideQuotes(s: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < s.length) {
        cur += c + s[++i];
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    const m = sep.exec(s.slice(i));
    if (m) {
      parts.push(cur);
      cur = "";
      i += m[0].length - 1;
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** 极简 shell 分词：引号内原样（双引号里 `\"` 反转义），引号外按空白切。 */
function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && (s[i + 1] === '"' || s[i + 1] === "\\")) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

/** 一个标识符的语义摘要；没有可信答案 → null（不附）。 */
async function glanceOne(deps: GlanceDeps, name: string): Promise<string | null> {
  const [sym, refs] = await Promise.all([
    deps.query("symbols", { name }, GLANCE_BUDGET_MS),
    deps.query("references", { name }, GLANCE_BUDGET_MS),
  ]);
  if (sym.ambiguous) {
    const cands = (sym.candidates ?? []) as Array<{ file_path?: string; line?: number; kind?: number }>;
    const n = sym.count ?? cands.length;
    // 候选不多就直接列出来——「有 N 个同名」而不说在哪，模型只能再 grep 一轮。
    const where =
      cands.length > 0 && cands.length <= MAX_LISTED
        ? `: ${cands.map((c) => `${kindWord(c.kind)} ${displayPath(c.file_path ?? "?", deps.cwd)}:${c.line ?? 1}`).join(", ")}`
        : "";
    return `- \`${name}\`: ${n} symbols share this name${where} — lsp_references {name:"${name}", file:<one of them>} picks one`;
  }
  const defs = locsOf(sym.results);
  if (sym.status !== "ready" || defs.length === 0) return null;
  const where = (await Promise.all(defs.slice(0, MAX_LISTED).map((d) => describeDef(deps, d, name)))).join(", ");
  let usage = "";
  if (refs.status === "ready" && !refs.ambiguous) {
    const locs = locsOf(refs.results);
    const files = new Set(locs.map((l) => l.file)).size;
    usage =
      locs.length === 0
        ? " · no references anywhere (confirmed)"
        : ` · ${locs.length} real reference${locs.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
  }
  return `- \`${name}\`: ${where}${usage}`;
}

/** 候选/定义最多列几个。 */
const MAX_LISTED = 4;

/** 定义处：种类 + 位置 + 行区间（模型据此 `Read offset/limit` 精确取段，不必整文件读）。
 *  取结构失败就只给位置——附注宁可少一点，不可错。 */
async function describeDef(deps: GlanceDeps, d: Loc, name: string): Promise<string> {
  const at = `${displayPath(d.file, deps.cwd)}:${d.line}`;
  const outline = await deps.query("outline", { file: d.file }, GLANCE_BUDGET_MS).catch(() => null);
  const nodes = outline?.status === "ready" ? ((outline.symbols ?? []) as OutlineNode[]) : [];
  const node = declaredAt(nodes, d.line, name);
  if (!node) return `defined at ${at}`;
  const span = node.end_line > node.start_line ? `, lines ${node.start_line}-${node.end_line}` : "";
  return `${kindWord(node.kind)} defined at ${at}${span}`;
}

/** PostToolUse hook（Grep / Bash）。 */
export function makeLspGlanceHook(deps: GlanceDeps): HookCallback {
  const seen: string[] = []; // 同一会话里重复搜同一批名字，不重复附
  const misses = new Map<string, number>(); // 名字 → 没答上的次数
  return async (input: HookInput) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    if (!deps.isWarm()) return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const ids =
      input.tool_name === "Grep"
        ? identifiersFromGrepTool(toolInput)
        : input.tool_name === "Bash" && typeof toolInput.command === "string"
          ? identifiersFromBash(toolInput.command)
          : [];
    const picked = ids.filter((n) => (misses.get(n) ?? 0) < MAX_MISSES).slice(0, MAX_GLANCE_IDENTS);
    if (picked.length === 0) return {};
    const key = picked.join("|");
    if (seen.includes(key)) return {};

    const lines = await Promise.race([
      Promise.all(picked.map((n) => glanceOne(deps, n).catch(() => null))),
      new Promise<null>((r) => setTimeout(() => r(null), GLANCE_BUDGET_MS + 500)),
    ]);
    picked.forEach((n, i) => {
      if (!lines?.[i]) misses.set(n, (misses.get(n) ?? 0) + 1);
    });
    const kept = (lines ?? []).filter((l): l is string => !!l);
    if (kept.length === 0) return {};
    seen.push(key);
    if (seen.length > 50) seen.shift();
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        additionalContext:
          `aide-lsp (compiler-accurate) on the identifiers in this search:\n${kept.join("\n")}\n` +
          `lsp_references lists every real use with its enclosing function; lsp_definition returns the full body.`,
      },
    };
  };
}
