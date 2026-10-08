// 渲染页上的一个 DOM 选区 → 存储的 markdown 源文里的精确范围。
//
// 「圈中什么改什么」的第一道关：agent 之后只能改这里算出来的 [start, end)。所以宁可把范围
// 扩大到整块（并如实标 precise=false 让界面告诉用户），也不猜——猜错的代价是改了用户没圈的东西。
//
// 两档：
//   精确：选区落在**同一个块**里，且选中的文字在该块源文里能唯一对上（DOM 里第 k 次出现 ↔ 源文里
//         第 k 次出现，且两边出现总次数相等——说明标记没有凭空造出或吞掉这个词）→ 范围就是那几个字。
//   整块：跨块 / 含加粗链接等格式 / 对不上 → 范围扩大到涉及的块（块的位置来自渲染时写进去的
//         data-s / data-e，见 markdown.ts，不靠文字搜索）。
// 选到没有源文位置的区域（组件标签残片等）→ 拒绝，不退化成猜。

export interface ResolvedScope {
  /** 源文偏移 [start, end)，UTF-16。 */
  start: number;
  end: number;
  /** 恒等于 source.slice(start, end)。 */
  text: string;
  /** 行号（1-based 闭区间），仅供展示。 */
  lineStart: number;
  lineEnd: number;
  /** true = 范围就是用户选的那几个字；false = 已扩大到整块。 */
  precise: boolean;
  /** 用来画高亮的 DOM 区间（精确档 = 选区本身；整块档 = 涉及的块的外沿）。 */
  highlight: Range;
}

export type ScopeResult =
  | { ok: true; scope: ResolvedScope }
  | { ok: false; reason: "empty" | "outside" | "unlocatable" };

/** 渲染出来的界面零件（代码块的语言标签 / 复制按钮），不是正文，不参与文字对位。 */
function isChrome(node: Node): boolean {
  const el = node.parentElement;
  return !!el?.closest(".kb-code-bar, [data-kb-copy]");
}

function textNodesOf(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!isChrome(n)) out.push(n as Text);
  }
  return out;
}

interface Piece {
  node: Text;
  /** 选区落在这个文本节点里的部分 [from, to)。 */
  from: number;
  to: number;
}

/** 选区实际覆盖的、有可见文字的文本片段（文档序）。三击选段会把 end 落在下一块开头，
 *  按「有非空白字符」筛，就不会把下一块算进来。 */
function selectedPieces(range: Range, body: HTMLElement): Piece[] {
  const pieces: Piece[] = [];
  for (const node of textNodesOf(body)) {
    if (!range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to <= from) continue;
    if (node.data.slice(from, to).trim() === "") continue;
    pieces.push({ node, from, to });
  }
  return pieces;
}

function blockOf(node: Node, body: HTMLElement): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const hit = el?.closest<HTMLElement>("[data-s]") ?? null;
  return hit && body.contains(hit) ? hit : null;
}

export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) line += 1;
  return line;
}

/** needle 在 hay 里所有出现位置（允许重叠）。 */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function finish(source: string, start: number, end: number, precise: boolean, highlight: Range): ScopeResult {
  return {
    ok: true,
    scope: {
      start,
      end,
      text: source.slice(start, end),
      lineStart: lineOf(source, start),
      lineEnd: lineOf(source, Math.max(start, end - 1)),
      precise,
      highlight,
    },
  };
}

export function scopeFromRange(range: Range, body: HTMLElement, source: string): ScopeResult {
  if (range.collapsed) return { ok: false, reason: "empty" };
  if (!body.contains(range.commonAncestorContainer)) return { ok: false, reason: "outside" };

  const pieces = selectedPieces(range, body);
  if (pieces.length === 0) return { ok: false, reason: "empty" };

  const first = pieces[0]!;
  const last = pieces[pieces.length - 1]!;
  const sb = blockOf(first.node, body);
  const eb = blockOf(last.node, body);
  if (!sb || !eb) return { ok: false, reason: "unlocatable" };

  // ── 精确档：同一个块 ──
  if (sb === eb) {
    const blockStart = Number(sb.dataset.s);
    const blockEnd = Number(sb.dataset.e);
    // 代码块里选，对位只在 <pre> 内进行（语言标签与复制按钮已被 isChrome 排除，但前缀还是更稳）
    const root: HTMLElement = first.node.parentElement?.closest("pre") ?? sb;
    const rootNodes = textNodesOf(root);
    const domText = rootNodes.map((n) => n.data).join("");

    const raw = pieces.map((p) => p.node.data.slice(p.from, p.to)).join("");
    const sel = raw.trim();
    if (sel === "") return { ok: false, reason: "empty" };
    const lead = raw.length - raw.trimStart().length;

    let acc = 0;
    for (const n of rootNodes) {
      if (n === first.node) break;
      acc += n.data.length;
    }
    const domStart = acc + first.from + lead;

    const domHits = occurrences(domText, sel);
    const k = domHits.filter((i) => i < domStart).length;
    const srcHits = occurrences(source.slice(blockStart, blockEnd), sel);
    if (srcHits.length > 0 && srcHits.length === domHits.length && domHits[k] === domStart) {
      const start = blockStart + srcHits[k]!;
      return finish(source, start, start + sel.length, true, range.cloneRange());
    }
  }

  // ── 整块档 ──
  const s = Math.min(Number(sb.dataset.s), Number(eb.dataset.s));
  const e = Math.max(Number(sb.dataset.e), Number(eb.dataset.e));
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return { ok: false, reason: "unlocatable" };
  const hl = document.createRange();
  hl.setStartBefore(sb);
  hl.setEndAfter(eb);
  return finish(source, s, e, false, hl);
}
