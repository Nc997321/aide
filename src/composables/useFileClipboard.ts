import { ref, readonly } from "vue";
import { api } from "../api";
import { useModal } from "./useModal";

export interface ClipboardEntry {
  op: 'copy' | 'cut';
  path: string;
}

const clipboard = ref<ClipboardEntry | null>(null);
const modal = useModal();

export function getParentPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const i = path.lastIndexOf(sep);
  return i > 0 ? path.slice(0, i) : path;
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

export function useFileClipboard() {
  function copy(path: string) { clipboard.value = { op: 'copy', path }; }
  function cut(path: string)  { clipboard.value = { op: 'cut',  path }; }
  function clear()            { clipboard.value = null; }

  async function executePaste(
    targetDir: string,
    onRefreshSrc: () => void,
    onRefreshDest: () => void,
  ): Promise<void> {
    const entry = clipboard.value;
    if (!entry) return;

    const sep = targetDir.includes("\\") ? "\\" : "/";
    const dest = `${targetDir}${sep}${basename(entry.path)}`;

    // 粘贴到相同位置是空操作
    if (entry.path === dest) { clear(); return; }

    async function doOp(e: ClipboardEntry) {
      if (e.op === 'copy') {
        await api.copyFile(e.path, dest);
      } else {
        await api.moveFile(e.path, dest);
      }
    }

    try {
      await doOp(entry);
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith("EXISTS:")) {
        const filename = msg.slice("EXISTS:".length);
        const ok = await modal.confirm(
          "目标已存在",
          `目标已存在「${filename}」，是否覆盖？`,
          "覆盖",
          true,
        );
        if (!ok) return;
        await api.deleteFile(dest);
        await doOp(entry);
      } else {
        throw err;
      }
    }

    clear();
    onRefreshDest();
    if (entry.op === 'cut') onRefreshSrc();
  }

  return { clipboard: readonly(clipboard), copy, cut, clear, executePaste };
}
