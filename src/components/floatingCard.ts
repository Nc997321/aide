/** FloatingCard 的锚点矩形（视口坐标）。单独放 .ts：.vue 里导出的类型普通 TS 文件拿不到。 */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** DOM 矩形 → 锚点（拷贝出来，免得攥着活的 DOMRect）。 */
export function anchorOf(r: DOMRect | null | undefined): AnchorRect | null {
  return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
}
