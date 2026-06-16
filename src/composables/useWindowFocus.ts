import { ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isFocused = ref(true);

export function useWindowFocus() {
  async function init() {
    await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      isFocused.value = focused;
    });
    // Fetch initial focus state in case the listener already missed it
    try {
      isFocused.value = await getCurrentWindow().isFocused();
    } catch (_) {}
  }

  return { isFocused, init };
}
