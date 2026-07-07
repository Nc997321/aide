import type { Directive, DirectiveBinding } from "vue";
import { useScrollMemory } from "../composables/useScrollMemory";

/**
 * v-scroll-memory="key" —— 普通滚动容器的滚动位置记忆（事件层）。
 *
 * 挂载时从 useScrollMemory（会话级内存，重启即忘）恢复上次位置，
 * 之后监听 scroll 持续记录。用于文件窗口的 Markdown 预览 / 只读 pre
 * 等非 CodeMirror 的滚动面（CodeMirror 走 extensions/cmScrollMemory）。
 *
 * 恢复在 mounted 里直接设 scrollTop：v-html 内容此刻已同步渲染完，
 * 高度可用；后续图片加载等造成的高度漂移不追。
 */

interface ScrollMemoryState {
  key: string;
  onScroll: () => void;
}

const stateMap = new WeakMap<HTMLElement, ScrollMemoryState>();

export const vScrollMemory: Directive<HTMLElement, string> = {
  mounted(el: HTMLElement, binding: DirectiveBinding<string>) {
    if (!binding.value) return;
    const { remember, recall } = useScrollMemory();

    const state: ScrollMemoryState = {
      key: binding.value,
      onScroll: () => remember(state.key, el.scrollTop),
    };
    stateMap.set(el, state);

    const saved = recall(state.key);
    if (saved !== undefined && saved > 0) el.scrollTop = saved;

    el.addEventListener("scroll", state.onScroll, { passive: true });
  },

  updated(el: HTMLElement, binding: DirectiveBinding<string>) {
    const state = stateMap.get(el);
    if (state && binding.value) state.key = binding.value;
  },

  unmounted(el: HTMLElement) {
    const state = stateMap.get(el);
    if (!state) return;
    el.removeEventListener("scroll", state.onScroll);
    stateMap.delete(el);
  },
};
