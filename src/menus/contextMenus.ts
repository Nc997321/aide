import type { MenuItem } from "../composables/useContextMenu";
import { useModal } from "../composables/useModal";
import { useFileViewer } from "../composables/useFileViewer";
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
import { api } from "../api";

function sep(): MenuItem {
  return { label: "", separator: true };
}

const modal = useModal();
const cb = useFileClipboard();

// ── File context menu ──

export function fileMenuItems(
  path: string,
  projectRoot: string,
  onDeleted?: () => void,
  sessionId?: string,
): MenuItem[] {
  const fileName = path.split(/[/\\]/).pop() || path;
  const viewer = useFileViewer();
  const relPath = path.startsWith(projectRoot)
    ? path.slice(projectRoot.length).replace(/^[/\\]/, "").replace(/\\/g, "/")
    : path.replace(/\\/g, "/");
  return [
    { label: "查看/编辑", action: () => viewer.open(path) },
    { label: "其他方式打开", action: () => api.fileOpen(path) },
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(path) },
    ...(sessionId ? [{
      label: "添加到对话",
      action: () => api.ptyWrite(sessionId, `@${relPath} `).catch(() => {}),
    }] : []),
    { label: "复制路径", action: () => navigator.clipboard.writeText(path) },
    {
      label: "复制相对路径",
      action: () => {
        const rel = path.startsWith(projectRoot)
          ? path.slice(projectRoot.length).replace(/^[/\\]/, "")
          : path;
        navigator.clipboard.writeText(rel);
      },
    },
    sep(),
    { label: "复制", action: () => cb.copy(path) },
    { label: "剪切", action: () => cb.cut(path) },
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm("删除文件", `确定要删除「${fileName}」吗？`, "删除", true);
        if (!ok) return;
        await api.deleteFile(path);
        onDeleted?.();
      },
    },
  ];
}

// ── Directory context menu ──

export function directoryMenuItems(
  path: string,
  projectRoot: string,
  onToggle?: () => void,
  onRefresh?: () => void,
  onDeleted?: () => void,
  refreshDir?: (dirPath: string) => void,
): MenuItem[] {
  const dirName = path.split(/[/\\]/).pop() || path;
  return [
    { label: "展开/折叠", action: onToggle },
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(path) },
    { label: "复制路径", action: () => navigator.clipboard.writeText(path) },
    sep(),
    {
      label: "新建文件",
      action: async () => {
        const name = await modal.prompt("新建文件", "输入文件名...", "创建");
        if (!name) return;
        await api.createFile(path, name);
        onRefresh?.();
      },
    },
    {
      label: "新建文件夹",
      action: async () => {
        const name = await modal.prompt("新建文件夹", "输入文件夹名...", "创建");
        if (!name) return;
        await api.createDir(path, name);
        onRefresh?.();
      },
    },
    sep(),
    { label: "复制", action: () => cb.copy(path) },
    // 根目录不可剪切
    ...(path !== projectRoot ? [{ label: "剪切", action: () => cb.cut(path) }] : []),
    ...(cb.clipboard.value ? [
      {
        label: "粘贴",
        action: async () => {
          const entry = cb.clipboard.value;
          if (!entry) return;
          const srcParent = getParentPath(entry.path);
          await cb.executePaste(
            path,
            () => (refreshDir ? refreshDir(srcParent) : onRefresh?.()),
            () => onRefresh?.(),
          );
        },
      },
    ] : []),
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm("删除文件夹", `确定要删除「${dirName}」及其所有内容吗？`, "删除", true);
        if (!ok) return;
        await api.deleteFile(path);
        onDeleted?.();
      },
    },
  ];
}

// ── File tree blank area ──

export function fileTreeAreaMenuItems(rootPath: string, onRefresh: () => void): MenuItem[] {
  return [
    { label: "刷新", action: onRefresh },
    sep(),
    {
      label: "新建文件",
      action: async () => {
        const name = await modal.prompt("新建文件", "输入文件名...", "创建");
        if (!name) return;
        await api.createFile(rootPath, name);
        onRefresh();
      },
    },
    {
      label: "新建文件夹",
      action: async () => {
        const name = await modal.prompt("新建文件夹", "输入文件夹名...", "创建");
        if (!name) return;
        await api.createDir(rootPath, name);
        onRefresh();
      },
    },
  ];
}

// ── Session context menu ──

export function sessionMenuItems(
  id: string,
  onRenamed: (name: string) => void,
  onDeleted: () => void,
): MenuItem[] {
  return [
    {
      label: "重命名",
      action: async () => {
        const name = await modal.prompt("重命名会话", "输入新名称...", "保存");
        if (name) onRenamed(name);
      },
    },
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm(
          "删除会话",
          "此操作将同时删除 Claude 原生的对话记录（.jsonl），无法通过 --resume 恢复。确定删除？",
          "删除",
          true,
        );
        if (!ok) return;
        await api.deleteSession(id);
        onDeleted();
      },
    },
  ];
}
