// 文档结构：大纲解析与按章节 / 行区间切片（纯函数，单测直接覆盖）。
//
// 为什么要有它：`read_document` 只能整篇读，长文档（整页文档站导入的几万字）一次读进来
// 既烧上下文又把要找的那几行淹没。给 agent 一张「标题 + 行号」的地图，让它先看地图、
// 再只读要的那一节——和 LSP 工具「每一发都要比 grep 值」是同一个原则。
//
// 标题来源有两种，都认：
//  - ATX：`## 标题`（Markdown 本体）；
//  - 行内 HTML：`<h2 id="x"> 标题 </h2>`（导入的文档站 md 里到处是，一行里还可能连着好几个）。
// 围栏代码块（``` / ~~~）里的一律不算——那是文档在**讲**标题，不是在用。
//
// 行号 1 起算、闭区间，与 `read_document` 的 startLine / endLine 同一口径。
//
// 注：前端阅读页的目录直接读渲染出来的 DOM 标题，不复用这里（sidecar 不在 workspace，
// 也没必要为 30 行解析器拉一个共享包）。

export interface KbHeading {
  /** 1–6 */
  level: number;
  /** 去掉标记与首尾空白后的标题文字 */
  title: string;
  /** 标题所在行（1 起算） */
  line: number;
  /** 本节最后一行（含子节）：到下一个「同级或更高级」标题的前一行，或文末 */
  endLine: number;
}

const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const HTML_HEADING_RE = /<h([1-6])(?:\s[^<>]*)?>([\s\S]*?)<\/h\1>/gi;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** 标题文字里的行内标记（强调 / 行内代码 / 链接）剥掉，留下人读的那串字。 */
function plainTitle(raw: string): string {
  return raw
    .replace(/<[^<>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseOutline(markdown: string): KbHeading[] {
  const lines = markdown.split("\n");
  const found: { level: number; title: string; line: number }[] = [];

  let fence: string | null = null;
  lines.forEach((text, i) => {
    const f = FENCE_RE.exec(text);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;

    const atx = ATX_RE.exec(text);
    if (atx) {
      const title = plainTitle(atx[2]);
      if (title) found.push({ level: atx[1].length, title, line: i + 1 });
      return;
    }
    if (text.includes("<h") || text.includes("<H")) {
      for (const m of text.matchAll(HTML_HEADING_RE)) {
        const title = plainTitle(m[2]);
        if (title) found.push({ level: Number(m[1]), title, line: i + 1 });
      }
    }
  });

  const last = lines.length;
  return found.map((h, idx) => {
    // 下一个同级或更高级标题；同一行里连着的标题，本节至少含它自己那一行
    const next = found.slice(idx + 1).find((n) => n.level <= h.level);
    const endLine = next ? Math.max(h.line, next.line - 1) : last;
    return { ...h, endLine };
  });
}

export type SectionLookup =
  | { kind: "found"; heading: KbHeading }
  | { kind: "ambiguous"; candidates: KbHeading[] }
  | { kind: "none" };

/** 按标题文字找章节：先整串相等（忽略大小写），再退到「恰好一个包含」；多个就交回候选，不替模型猜。 */
export function findSection(outline: KbHeading[], query: string): SectionLookup {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: "none" };

  const exact = outline.filter((h) => h.title.toLowerCase() === q);
  if (exact.length === 1) return { kind: "found", heading: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", candidates: exact };

  const partial = outline.filter((h) => h.title.toLowerCase().includes(q));
  if (partial.length === 1) return { kind: "found", heading: partial[0] };
  if (partial.length > 1) return { kind: "ambiguous", candidates: partial };
  return { kind: "none" };
}

/** 取行区间 [start, end]（1 起算闭区间）；越界按文档边界收紧，反向区间返回空。 */
export function sliceLines(markdown: string, start: number, end: number): { text: string; start: number; end: number; total: number } {
  const lines = markdown.split("\n");
  const total = lines.length;
  const s = Math.max(1, Math.min(start, total));
  const e = Math.max(0, Math.min(end, total));
  if (e < s) return { text: "", start: s, end: e, total };
  return { text: lines.slice(s - 1, e).join("\n"), start: s, end: e, total };
}
