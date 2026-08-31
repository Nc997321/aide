import { ref, readonly } from "vue";
import { api } from "../api";
import { useModal } from "./useModal";

export interface ClipboardEntry {
  op: 'copy' | 'cut';
  paths: string[];
}

const clipboard = ref<ClipboardEntry | null>(null);
const modal = useModal();

/** Read the current in-app clipboard entry without clearing it.
 *  Used by the terminal's Ctrl+V paste to turn a file-tree "copy" into an
 *  `@path` mention. Does not affect the file-tree move semantics. */
export function peekFileClipboard(): ClipboardEntry | null {
  return clipboard.value;
}

/** Clear the in-app file clipboard entry. Used by the chat input's drop
 *  handler after a file-tree node is dragged *into the input* (a reference,
 *  not a move) so the cut-state doesn't linger and the file isn't later moved
 *  by a tree "粘贴". Standalone (mirrors peekFileClipboard) so callers don't
 *  need the useFileClipboard() hook. */
export function clearFileClipboard(): void {
  clipboard.value = null;
}

export function getParentPath(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const i = path.lastIndexOf(sep);
  return i > 0 ? path.slice(0, i) : path;
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** executePaste 的刷新回调：多源粘贴后按「受影响目录」批量刷新（dirs 已
 *  去重）。复制只触发 onDestRefresh；剪切另触发 onSrcRefresh。 */
export interface PasteHooks {
  onDestRefresh: (dirs: string[]) => void;
  onSrcRefresh: (dirs: string[]) => void;
}

export function useFileClipboard() {
  /** copy/cut 接多路径：树内 Ctrl+C 总是单条，OS 剪贴板来源（Explorer 多选
   *  复制 → 树内 Ctrl+V）天然多条，统一数组。调用方传 `[path]` 包装单条。 */
  function copy(paths: string[]) { clipboard.value = { op: 'copy', paths }; }
  function cut(paths: string[])  { clipboard.value = { op: 'cut',  paths }; }
  function clear()               { clipboard.value = null; }

  /** 用户发起的复制/剪切（Ctrl+C/X、右键菜单）：应用内 + 系统剪贴板双写，
   *  资源管理器里 Ctrl+V 才能接住。拖拽（TreeNodeItem.onDragStart）不要走
   *  这两个——拖拽是移动语义，不应劫持系统剪贴板。写失败静默（应用内仍可用）。 */
  function copyWithOs(paths: string[]) {
    copy(paths);
    void api.clipboardWriteFiles(paths, "copy").catch(() => {});
  }
  function cutWithOs(paths: string[]) {
    cut(paths);
    void api.clipboardWriteFiles(paths, "cut").catch(() => {});
  }

  /**
   * 粘贴来源解析（Ctrl+V 与右键菜单共用）：应用内剪贴板优先；为空则读系统
   * 剪贴板（Explorer 复制/剪切，带 op 语义）并种为应用内条目，之后全走
   * executePaste 同一条管道——不为 OS 来源另开第二条粘贴实现。
   * 两处都没有文件返回 null（调用方决定提示或静默）。
   */
  async function resolvePasteEntry(): Promise<ClipboardEntry | null> {
    if (clipboard.value) return clipboard.value;
    try {
      const res = await api.clipboardReadFiles();
      if (res.paths.length === 0) return null;
      const entry: ClipboardEntry = { op: res.op, paths: res.paths };
      clipboard.value = entry;
      return entry;
    } catch {
      return null;
    }
  }

  async function pasteOne(op: 'copy' | 'cut', src: string, dest: string): Promise<void> {
    if (op === 'copy') await api.copyFile(src, dest);
    else await api.moveFile(src, dest);
  }

  /**
   * 把 in-app 剪贴板（单条或多条）粘贴到 targetDir。EXISTS 冲突逐文件确认
   * 覆盖；目标位于任一源子树内整批拒绝。粘贴后一次性推送去重的刷新目录——
   * 回调拿目录数组而不是「单源父目录」，OS 多源粘贴时才不刷新错位。
   */
  async function executePaste(targetDir: string, hooks: PasteHooks): Promise<void> {
    const entry = clipboard.value;
    if (!entry || entry.paths.length === 0) return;

    const sep = targetDir.includes("\\") ? "\\" : "/";
    const nested = entry.paths.find(
      (p) => targetDir === p || targetDir.startsWith(p + sep),
    );
    if (nested) {
      await modal.confirm("操作无效", "不能将文件夹粘贴到其自身的子目录中", "确定", false);
      return;
    }

    const srcParents = new Set<string>();
    let moved = false;
    for (const src of entry.paths) {
      const dest = `${targetDir}${sep}${basename(src)}`;
      if (src === dest) continue; // 粘贴到相同位置是空操作（多条时仅该条跳过）
      try {
        await pasteOne(entry.op, src, dest);
        moved = true;
        if (entry.op === 'cut') srcParents.add(getParentPath(src));
      } catch (err) {
        const msg = String(err);
        if (!msg.startsWith("EXISTS:")) throw err;
        const filename = msg.slice("EXISTS:".length);
        const ok = await modal.confirm(
          "目标已存在",
          `目标已存在「${filename}」，是否覆盖？`,
          "覆盖",
          true,
        );
        if (!ok) continue;
        await api.deleteFile(dest);
        await pasteOne(entry.op, src, dest);
        moved = true;
        if (entry.op === 'cut') srcParents.add(getParentPath(src));
      }
    }

    clear();
    if (moved) {
      hooks.onDestRefresh([targetDir]);
      if (entry.op === 'cut') hooks.onSrcRefresh([...srcParents]);
    }
  }

  return { clipboard: readonly(clipboard), copy, cut, copyWithOs, cutWithOs, clear, executePaste, resolvePasteEntry };
}