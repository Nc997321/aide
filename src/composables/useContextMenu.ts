import { ref, readonly } from "vue";

export interface MenuItem {
  label: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** 警示色（黄）菜单项，与行内警示图标同色——用于「信任此工作区」这类状态纠正入口 */
  warning?: boolean;
  /** Icon glyph (single character or emoji) shown before the label */
  icon?: string;
  /** Keyboard shortcut hint shown right-aligned */
  kbd?: string;
}

// Module-level singletons — all callers share the same refs
const visible = ref(false);
const x = ref(0);
const y = ref(0);
const items = ref<MenuItem[]>([]);

export function useContextMenu() {
  function show(px: number, py: number, menuItems: MenuItem[]) {
    if (menuItems.length === 0) return;
    x.value = px;
    y.value = py;
    items.value = menuItems;
    visible.value = true;
  }

  function hide() {
    visible.value = false;
  }

  return {
    visible: readonly(visible),
    x: readonly(x),
    y: readonly(y),
    items: readonly(items),
    show,
    hide,
  };
}
