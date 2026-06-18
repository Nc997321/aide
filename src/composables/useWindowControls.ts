import { ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isMaximized = ref(false);

let initialized = false;

export function useWindowControls() {
  const window = getCurrentWindow();

  async function init() {
    if (initialized) return;
    initialized = true;

    // Get initial maximize state
    try {
      isMaximized.value = await window.isMaximized();
    } catch (_) { /* ignore */ }

    // Listen for resize changes to update maximize state
    await window.onResized(async () => {
      try {
        isMaximized.value = await window.isMaximized();
      } catch (_) { /* ignore */ }
    });
  }

  async function minimize() {
    try {
      await window.minimize();
    } catch (_) { /* ignore */ }
  }

  async function toggleMaximize() {
    try {
      await window.toggleMaximize();
    } catch (_) { /* ignore */ }
  }

  async function close() {
    try {
      await window.close();
    } catch (_) { /* ignore */ }
  }

  function startDragging() {
    try {
      window.startDragging();
    } catch (_) { /* ignore */ }
  }

  return { isMaximized, init, minimize, toggleMaximize, close, startDragging };
}
