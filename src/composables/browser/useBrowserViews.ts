// 浏览器视图的**常驻订阅层**：面板是懒挂载的（第一次点开才挂），而 agent 可能在那之前就开了 tab、
// 甚至请求 focus——这些事件必须有人接住，否则"agent 开了 tab 但面板里什么都没有"。
//
// # 通道只有一条
//
// 事件**一律先进缓冲**，面板 watch 缓冲并 `takeViewEvents()` 取走（取走即清空）。面板**不要**再自己
// `onBrowserView` 订阅一次——那样 live 事件与缓冲会各应用一次（同一个 created 应用两遍），
// 而且面板挂载前收到的事件会丢。
//
// # focus 是请求
//
// 显示权在面板（方案 A）：这里只做两件事——幂等展开右栏、把待切的视图 id 记下来。
// 真正切标签由面板消费 `pendingFocusViewId` 完成。
import { ref } from "vue";

import { useRightPanel } from "../useRightPanel";
import { onBrowserFocus, onBrowserView, type ViewEventDto } from "./useEmbeddedBrowser";

/** 面板挂载后要切过去的视图（focus 先到、面板后到）。 */
const pendingFocusViewId = ref<string | null>(null);

/** 待面板消费的增量。**整数组替换**（不是 push）：watch 靠引用变化触发，原地改数组不会唤醒面板。 */
const buffered = ref<ViewEventDto[]>([]);

let installed = false;

function handleView(e: ViewEventDto): void {
  buffered.value = [...buffered.value, e];
  // 视图没了就别再等它：pending 挂在已关闭的 id 上会把下一次 focus 也带偏。
  if (e.kind === "closed" && pendingFocusViewId.value === e.id) {
    pendingFocusViewId.value = null;
  }
}

function handleFocus(e: { id: string }): void {
  // 幂等展开，**不是** `select('browser')`——那是 toggle，用户正看着浏览器时会把它收起来。
  useRightPanel().ensureBrowserShown();
  pendingFocusViewId.value = e.id;
}

export function useBrowserViews() {
  if (!installed) {
    installed = true;
    void onBrowserView(handleView);
    void onBrowserFocus(handleFocus);
  }
  return {
    /** 待切视图（面板 watch 它）。 */
    pendingFocusViewId,
    /** 待消费增量（面板 watch 它，然后 `takeViewEvents()`）。 */
    buffered,
    /**
     * 取走增量（取走即清空）。
     *
     * ⚠️ **只在真有内容时才改引用**：面板在 `watch(buffered)` 的回调里调它，无条件赋空数组
     * 每一次都是一个新引用 → watcher 自激（实测炸出 "Maximum recursive updates exceeded"）。
     */
    takeViewEvents(): ViewEventDto[] {
      const out = buffered.value;
      if (out.length) buffered.value = [];
      return out;
    },
    /** 消费一次 focus 请求：id 对得上就清掉并回 true。 */
    consumePendingFocus(viewId: string): boolean {
      if (pendingFocusViewId.value !== viewId) return false;
      pendingFocusViewId.value = null;
      return true;
    },
    /** 仅供测试：免事件桥直接投递载荷。 */
    __handleViewForTest: handleView,
    __handleFocusForTest: handleFocus,
  };
}

/** 仅供测试复位模块单例（同 `__resetRightPanelForTest` 范式）。 */
export function __resetBrowserViewsForTest() {
  pendingFocusViewId.value = null;
  buffered.value = [];
  installed = false;
}
