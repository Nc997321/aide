/**
 * 消息里选中的文字（「引用 / 派给子会话」小浮条用）。
 *
 * 只认落在**同一条消息**的正文（`.msg-text`）里的选区：跨两条消息、或只选中了工具行 /
 * 卡片里的字，不出浮条。选区以 Range 的拷贝留着，滚动时据它重算位置；DOM 重渲染让它塌缩了
 * 就当选区没了。
 */
import type { AnchorRect } from "../floatingCard";

/** 选区文字上限（字符）：再长就不是「一段话」了，截掉免得任务说明撑爆。 */
export const SELECTION_MAX_CHARS = 6000;

export interface MessageSelection {
  text: string;
  range: Range;
}

function elementOf(n: Node | null): Element | null {
  if (!n) return null;
  return n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
}

export function readMessageSelection(root: HTMLElement | null, sel: Selection | null): MessageSelection | null {
  if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const text = sel.toString().trim();
  if (!text) return null;
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  if (!start || !end || !root.contains(start) || !root.contains(end)) return null;
  const msg = start.closest("[data-msg-id]");
  if (!msg || !msg.contains(end)) return null;
  // 起点必须在正文里；终点放宽：三击选整段时终点常落在下一个块的开头（偏移 0）
  if (!start.closest(".msg-text")) return null;
  if (!end.closest(".msg-text") && !(range.endOffset === 0 && msg.contains(end))) return null;
  const clipped = text.length > SELECTION_MAX_CHARS ? `${text.slice(0, SELECTION_MAX_CHARS)}…` : text;
  return { text: clipped, range: range.cloneRange() };
}

/** 选区最后一行的矩形（浮条挂在末尾）；塌缩 / 量不到 → null。 */
export function selectionEndRect(range: Range): AnchorRect | null {
  if (range.collapsed) return null;
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  const r = rects[rects.length - 1];
  if (!r) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** 整个选区的外接矩形（派活浮窗贴在选区下方）。 */
export function selectionRect(range: Range): AnchorRect | null {
  if (range.collapsed) return null;
  const r = range.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** 矩形是否还在可视区里（滚出消息区就收起浮条）。 */
export function rectVisibleIn(rect: AnchorRect, box: DOMRect): boolean {
  return rect.bottom > box.top && rect.top < box.bottom;
}
