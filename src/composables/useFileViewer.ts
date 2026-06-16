import { ref, readonly } from "vue";
import { invoke } from "@tauri-apps/api/core";

// Module-level singletons
const visible = ref(false);
const filePath = ref("");
const content = ref("");
const error = ref("");
const editing = ref(false);
const editContent = ref("");
const saving = ref(false);

export function useFileViewer() {
  async function open(path: string) {
    filePath.value = path;
    error.value = "";
    content.value = "";
    editing.value = false;
    editContent.value = "";
    try {
      content.value = await invoke<string>("read_file_content", { path });
    } catch (e) {
      error.value = String(e);
    }
    visible.value = true;
  }

  function startEdit() {
    editContent.value = content.value;
    editing.value = true;
  }

  async function save() {
    saving.value = true;
    try {
      await invoke("write_file_content", { path: filePath.value, content: editContent.value });
      content.value = editContent.value;
      editing.value = false;
    } catch (e) {
      error.value = String(e);
    }
    saving.value = false;
  }

  function cancelEdit() {
    editing.value = false;
    editContent.value = "";
  }

  function close() {
    visible.value = false;
    content.value = "";
    editing.value = false;
  }

  return {
    visible: readonly(visible),
    filePath: readonly(filePath),
    content: readonly(content),
    error: readonly(error),
    editing: readonly(editing),
    editContent,
    saving: readonly(saving),
    open, close, startEdit, save, cancelEdit,
  };
}
