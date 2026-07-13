import { ref } from "vue";

// 模块级单例：聚焦对话框（chat pane）的实时宽度 + 左边缘偏移（viewport 相对，px）。
// 终端面板绑定二者，使 pill 的左缘/宽度与聚焦对话框严格对齐——而不是在整窗居中
// （侧栏把对话框右推，居中的 pill 会比对话框偏右）。0 = 尚未测得（兜底 10px 边距）。
const chatPaneWidth = ref(0);
const chatPaneLeft = ref(0);

export function useChatPaneWidth() {
  return { chatPaneWidth, chatPaneLeft };
}

/** 供聚焦的 ChatPanel ResizeObserver 上报自身 border-box 位置。仅聚焦组应调用。
 *  用 getBoundingClientRect 而非 clientWidth，使 left/width 同属 border-box、
 *  终端 pill 能与对话框外框像素级对齐。 */
export function setChatPaneRect(left: number, width: number): void {
  if (width > 0) {
    chatPaneLeft.value = left;
    chatPaneWidth.value = width;
  }
}