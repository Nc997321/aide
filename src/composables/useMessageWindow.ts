import { computed, ref, watch } from "vue";

/**
 * 消息列表的窗口化渲染状态层:数据层照旧全量在 store(事件回填 tool_result
 * 需要全量在场),但进 v-for 建 DOM 的只有尾部一个有界窗口——聊天场景的
 * "反向分页":默认停在最新的 N 条,向上翻才逐步扩窗,已扩出的不回收。
 *
 * 为什么必须有这一层:一个长会话的 transcript 有几千个内容块,一次性挂载是
 * 几万个 DOM 节点 + 全量 Markdown 解析/代码高亮,切会话(PaneGroup 换
 * sessionId prop,v-for 新旧 key 完全不相交)时旧会话全量卸载 + 新会话全量
 * 挂载发生在同一个同步渲染补丁里,WebView 渲染线程 jam 数十秒,整窗未响应。
 * 窗口化后三条路径的成本同时封顶:切会话首帧、流式追加的 diff、强制布局
 * (scrollHeight 读取成本 ∝ DOM 体积)。
 *
 * 窗口语义:
 * - visible 永远是 source 的尾部切片——流式期间新消息追加,窗口自然滑动,
 *   最新内容始终在窗内;
 * - key(会话 id)变化时窗口重置回初始大小,不为旧会话记忆扩窗结果
 *   (切回来重新从尾部看,符合聊天软件惯例,也避免跨会话状态泄漏);
 * - 扩窗只增不减,同一会话内向上翻过的内容保持已挂载(避免虚拟列表在
 *   "高度不定 + 流式增高 + 折叠卡片"下的测量难题)。
 */
export interface MessageWindowOptions {
  /** 初始渲染的尾部条数 */
  initialSize?: number;
  /** 每次向上扩窗追加的条数 */
  step?: number;
}

const DEFAULT_INITIAL = 30;
const DEFAULT_STEP = 30;

export function useMessageWindow<T>(
  source: () => readonly T[],
  key: () => string | null,
  options: MessageWindowOptions = {},
) {
  const initialSize = options.initialSize ?? DEFAULT_INITIAL;
  const step = options.step ?? DEFAULT_STEP;

  const windowSize = ref(initialSize);

  watch(key, () => {
    windowSize.value = initialSize;
  });

  const visible = computed<readonly T[]>(() => {
    const list = source();
    // 整表不超窗直接透传原数组,不做无谓拷贝(也让 Vue 的 v-for diff 稳定)
    return list.length <= windowSize.value ? list : list.slice(-windowSize.value);
  });

  /** 窗口上方还藏着多少条(0 = 已全部可见,顶部入口不显示) */
  const hiddenCount = computed(() => Math.max(0, source().length - windowSize.value));

  /** 向上扩窗一步。滚动锚定(保持视觉位置)是 DOM 层的事,由调用方负责。 */
  function expandOlder() {
    if (hiddenCount.value > 0) windowSize.value += step;
  }

  return { visible, hiddenCount, expandOlder };
}
