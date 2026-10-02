// 源文偏移 → 渲染页上的 DOM 区间（scopeFromRange 的逆）。
//
// 圈选的所有高亮都由「源文偏移」推出来，而不是攥着一个 DOM Range 不放：正文重新渲染（文档被改、
// 切版本、图片撑开布局）之后 Range 会塌缩，偏移却永远有效。逆映射和正向用同一套对位规则：
// 单块内、文字能唯一对上 → 精确到字；否则退到涉及的整块。

export function rangeForSource(body: HTMLElement, source: string, start: number, end: number): Range | null {
  if (end <= start) return null;
  const blocks = [...body.querySelectorAll<HTMLElement>("[data-s]")].filter((el) => {
    const s = Number(el.dataset.s);
    const e = Number(el.dataset.e);
    return s < end && e > start;
  });
  if (blocks.length === 0) return null;

  // 嵌套时（列表 ul 里有 li）取最内层：外层包着内层，高亮取内层才贴合。
  const innermost = blocks.filter((b) => !blocks.some((o) => o !== b && b.contains(o)));
  const first = innermost[0]!;
  const last = innermost[innermost.length - 1]!;

  if (innermost.length === 1) {
    const precise = preciseRange(first, source, start, end);
    if (precise) return precise;
  }
  const r = document.createRange();
  r.setStartBefore(first);
  r.setEndAfter(last);
  return r;
}

function isChrome(node: Node): boolean {
  return !!node.parentElement?.closest(".kb-code-bar, [data-kb-copy]");
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (!isChrome(n)) out.push(n as Text);
  return out;
}

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function preciseRange(block: HTMLElement, source: string, start: number, end: number): Range | null {
  const bs = Number(block.dataset.s);
  const be = Number(block.dataset.e);
  // 范围必须整个落在这一块里才谈得上「精确到字」（块两端的半截选区不走这条）
  if (start < bs || end > be) return null;
  const needle = source.slice(start, end);
  if (needle.trim() === "") return null;

  const nodes = textNodes(block);
  const dom = nodes.map((n) => n.data).join("");
  const srcHits = occurrences(source.slice(bs, be), needle);
  const domHits = occurrences(dom, needle);
  const k = srcHits.indexOf(start - bs);
  if (k < 0 || srcHits.length !== domHits.length) return null;

  const at = domHits[k]!;
  const locate = (offset: number, preferEnd: boolean): [Text, number] | null => {
    let acc = 0;
    for (const n of nodes) {
      const next = acc + n.data.length;
      // 落在两个节点交界时：起点取后一个节点的开头，终点取前一个节点的结尾（Range 才不会多框一截）
      if (preferEnd ? offset <= next : offset < next) return [n, offset - acc];
      acc = next;
    }
    return null;
  };
  const s = locate(at, false);
  const e = locate(at + needle.length, true);
  if (!s || !e) return null;
  const r = document.createRange();
  r.setStart(s[0], s[1]);
  r.setEnd(e[0], e[1]);
  return r;
}
