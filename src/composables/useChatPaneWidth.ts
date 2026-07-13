import { ref } from "vue";

// 模块级单例：聚焦对话框（chat pane）的实时宽度（px）。终端面板绑定它。
// 0 = 尚未测得（终端面板在拿到值前用兜底宽度）。
const chatPaneWidth = ref(0);

export function useChatPaneWidth() {
  return { chatPaneWidth };
}

/** 供聚焦的 ChatPanel ResizeObserver 上报自身宽度。仅聚焦组应调用。 */
export function setChatPaneWidth(px: number): void {
  if (px > 0) chatPaneWidth.value = px;
}
