// DOM Range → 相对「滚动容器内容原点」的矩形列表（同一行的碎片合并成一条）。
//
// 圈选层是绝对定位在滚动容器里的：坐标取「相对容器内容原点」，滚动时它跟着内容走，不需要
// 监听 scroll；只有布局变化（改宽度 / 图片撑开 / 字体换上）才要重算。

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 同一行（纵向中心相差不到半个行高）且横向相接/重叠的碎片并成一条。行内加粗、链接、代码会把一行
 *  的选区切成好几段 DOM 矩形，不合并画出来就是断断续续的色块。 */
export function mergeLineRects(rects: readonly LayoutRect[], slack = 3): LayoutRect[] {
  const center = (r: LayoutRect) => r.y + r.h / 2;
  // 先按纵向中心分行（同一行的 y 会有 1~2px 的抖动，不能直接按 y 排序后按 x 合并），
  // 行内再按 x 排序合并。
  const byCenter = [...rects].sort((a, b) => center(a) - center(b));
  const lines: LayoutRect[][] = [];
  for (const r of byCenter) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(center(line[0]!) - center(r)) < Math.min(line[0]!.h, r.h) / 2) line.push(r);
    else lines.push([r]);
  }
  const out: LayoutRect[] = [];
  for (const line of lines) {
    const row = [...line].sort((a, b) => a.x - b.x);
    let cur = { ...row[0]! };
    for (const r of row.slice(1)) {
      if (r.x <= cur.x + cur.w + slack) {
        const right = Math.max(cur.x + cur.w, r.x + r.w);
        const top = Math.min(cur.y, r.y);
        const bottom = Math.max(cur.y + cur.h, r.y + r.h);
        cur = { x: cur.x, y: top, w: right - cur.x, h: bottom - top };
      } else {
        out.push(cur);
        cur = { ...r };
      }
    }
    out.push(cur);
  }
  return out;
}

/** range 的客户端矩形 → 相对 scrollEl 内容原点。宽或高为 0 的（折叠/不可见节点）丢掉。 */
export function rectsInScroller(range: Range, scrollEl: HTMLElement): LayoutRect[] {
  const box = scrollEl.getBoundingClientRect();
  const raw: LayoutRect[] = [];
  for (const r of Array.from(range.getClientRects())) {
    if (r.width <= 0 || r.height <= 0) continue;
    raw.push({
      x: r.left - box.left + scrollEl.scrollLeft,
      y: r.top - box.top + scrollEl.scrollTop,
      w: r.width,
      h: r.height,
    });
  }
  return mergeLineRects(raw);
}
