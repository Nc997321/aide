import { ref, readonly } from "vue";

export interface MenuItem {
  label: string;
  action?: () => void;
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
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
