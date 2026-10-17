import { nextTick, onMounted, watch, type Ref } from "vue";

/**
 * 文本框随内容自动撑高（单行输入框，2026-10-16）：空时一行，逐行长高到上限后内部滚动，
 * 内容清空（发送后）回落一行。
 *
 * 上限 = min(maxLines 行, 所在会话面板高度的 maxRatio)：窄高的分屏里不至于一个输入框
 * 吃掉半屏。高度直接写 style.height（先置 auto 量 scrollHeight 再定），不引测量库。
 */
export interface AutoGrowOptions {
  maxLines?: number;
  maxRatio?: number;
}

/** 纯计算：给定内容高度与上限，算出框高与是否需要内部滚动（单测入口）。 */
export function autoGrowHeight(
  scrollHeight: number,
  limits: { lineHeight: number; paddingY: number; maxLines: number; containerHeight: number; maxRatio: number },
): { height: number; scroll: boolean } {
  const byLines = limits.lineHeight * limits.maxLines + limits.paddingY;
  const byContainer = limits.containerHeight > 0 ? limits.containerHeight * limits.maxRatio : Infinity;
  const max = Math.max(limits.lineHeight + limits.paddingY, Math.min(byLines, byContainer));
  return { height: Math.min(scrollHeight, max), scroll: scrollHeight > max };
}

export function useAutoGrow(
  el: Ref<HTMLTextAreaElement | undefined | null>,
  text: Ref<string>,
  opts: AutoGrowOptions = {},
) {
  const maxLines = opts.maxLines ?? 12;
  const maxRatio = opts.maxRatio ?? 0.4;

  function resize() {
    const ta = el.value;
    if (!ta) return;
    const cs = getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const paddingY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const container = ta.closest(".chat-panel") as HTMLElement | null;
    ta.style.height = "auto";
    const { height, scroll } = autoGrowHeight(ta.scrollHeight, {
      lineHeight,
      paddingY,
      maxLines,
      containerHeight: container?.clientHeight ?? window.innerHeight,
      maxRatio,
    });
    ta.style.height = `${height}px`;
    ta.style.overflowY = scroll ? "auto" : "hidden";
  }

  watch(text, () => void nextTick(resize));
  onMounted(resize);
  return { resize };
}
