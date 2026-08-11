import { ref, watch, onScopeDispose, type Ref } from "vue";

/**
 * TaskListPanel 的自动折叠状态机——解决「todo 过长把输入框挤出可视区」的 UX 问题。
 *
 * 行为契约：
 * - tasks 长度增长（Claude 新建 task）→ 展开并重启 STABLE_MS 计时器；
 * - 计时器到点 → 自动折叠成摘要条，把高度还给消息区/输入框；
 * - 用户手动 toggle → 直接改折叠态并取消待执行的自动折叠；手动展开后不再被自动收起，
 *   直到下一次新建 task 重新启动自动折叠流程（用户意愿优先，和 ThinkingBlock.userOverride 同语义）。
 *
 * 只 watch 长度：状态更新（pending→in_progress→completed）不改长度，不触发展开，
 * 折叠态下进度仍在摘要条里实时更新。
 *
 * 注意：依赖 setup 上下文（watch / onScopeDispose），必须在组件 setup 中同步调用。
 */
const STABLE_MS = 800;

export function useTaskListCollapse(getLen: () => number): {
  collapsed: Ref<boolean>;
  toggleCollapse: () => void;
} {
  const collapsed = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let prevLen = 0;

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function scheduleCollapse() {
    clearTimer();
    timer = setTimeout(() => {
      collapsed.value = true;
      timer = undefined;
    }, STABLE_MS);
  }

  // immediate=true：首次挂载时 tasks 可能已有值（TaskListPanel 由 v-if=length>0 渲染，
  // 挂载即 N 个 task 视为「一次性创建 N 个」），需要展开 + 起计时，否则单批创建永不收起。
  watch(
    getLen,
    (len) => {
      if (len > prevLen) {
        collapsed.value = false;
        scheduleCollapse();
      }
      prevLen = len;
    },
    { immediate: true },
  );

  function toggleCollapse() {
    collapsed.value = !collapsed.value;
    clearTimer();
  }

  onScopeDispose(clearTimer);

  return { collapsed, toggleCollapse };
}