import { ref, readonly } from "vue";
import { api } from "../api";

// Module-level singletons
const visible = ref(false);
const filePath = ref("");
const content = ref("");
const language = ref("");
const error = ref("");
const editing = ref(false);
const editContent = ref("");
const saving = ref(false);
const projectRoot = ref("");

export function useFileViewer() {
  async function open(path: string, opts?: { content?: string; language?: string }) {
    filePath.value = path;
    error.value = "";
    content.value = "";
    language.value = opts?.language || "";
    editing.value = false;
    editContent.value = "";
    if (opts?.content !== undefined) {
      content.value = opts.content;
    } else {
      try {
        content.value = await api.readFileContent(path);
      } catch (e) {
        error.value = String(e);
      }
    }
    // Auto-detect project root for goto-definition
    try {
      const info = await api.getProjectInfo();
      projectRoot.value = info.root;
    } catch {
      // project root detection is best-effort
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
      await api.writeFileContent(filePath.value, editContent.value);
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

  // 跳转到目标文件，自动进入编辑模式并返回目标行
  async function openAndScrollTo(targetPath: string, line: number) {
    // close current viewer
    visible.value = false;
    // brief delay to allow state reset
    await new Promise(r => setTimeout(r, 50));
    // open target in preview mode first
    await open(targetPath);
    // auto-enter edit mode so CodeEditor mounts and can scroll
    if (content.value && !error.value && content.value.length <= 1_000_000) {
      editContent.value = content.value;
      editing.value = true;
    }
    return { line };
  }

  return {
    visible: readonly(visible),
    filePath: readonly(filePath),
    content: readonly(content),
    language: readonly(language),
    error: readonly(error),
    editing: readonly(editing),
    editContent,
    saving: readonly(saving),
    open, close, startEdit, save, cancelEdit,
    projectRoot: readonly(projectRoot),
    openAndScrollTo,
  };
}
