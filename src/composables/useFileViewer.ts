import { ref, readonly } from "vue";
import { invoke } from "@tauri-apps/api/core";

// Module-level singletons
const visible = ref(false);
const filePath = ref("");
const content = ref("");
const error = ref("");

export function useFileViewer() {
  async function open(path: string) {
    filePath.value = path;
    error.value = "";
    content.value = "";
    try {
      content.value = await invoke<string>("read_file_content", { path });
    } catch (e) {
      error.value = String(e);
    }
    visible.value = true;
  }

  function close() {
    visible.value = false;
    content.value = "";
  }

  return {
    visible: readonly(visible),
    filePath: readonly(filePath),
    content: readonly(content),
    error: readonly(error),
    open,
    close,
  };
}
