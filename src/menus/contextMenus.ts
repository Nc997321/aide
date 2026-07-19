import type { MenuItem } from "../composables/useContextMenu";
import { useModal } from "../composables/useModal";
import { useFileViewer } from "../composables/useFileViewer";
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
import { usePaneLayout } from "../composables/usePaneLayout";
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
  _sessionId?: string,
): MenuItem[] {
  const fileName = path.split(/[/\\]/).pop() || path;
  const viewer = useFileViewer();
  return [
    { label: "查看/编辑", action: () => viewer.open(path) },
    { label: "其他方式打开", action: () => api.fileOpen(path) },
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(path) },
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
    {
      label: "重命名",
      action: async () => {
        const newName = await modal.prompt("重命名文件", `「${fileName}」的新名称`, "重命名");
        if (!newName || newName === fileName) return;
        const newPath = path.slice(0, path.length - fileName.length) + newName;
        await api.moveFile(path, newPath);
        onDeleted?.();
      },
    },
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
    {
      label: "重命名",
      action: async () => {
        const newName = await modal.prompt("重命名文件夹", `「${dirName}」的新名称`, "重命名");
        if (!newName || newName === dirName) return;
        const newPath = path.slice(0, path.length - dirName.length) + newName;
        await api.moveFile(path, newPath);
        onDeleted?.();
      },
    },
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

export function fileTreeAreaMenuItems(
  rootPath: string,
  onRefresh: () => void,
  codegraph?: { rescan: (root: string) => void; rebuild: (root: string) => void },
): MenuItem[] {
  const items: MenuItem[] = [
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
  if (codegraph) {
    items.push(
      sep(),
      // 增量：只 reindex mtime>indexed_at 的改动文件，保留其余符号/向量。快。
      { label: "更新索引（仅改动文件）", action: () => codegraph.rescan(rootPath) },
      // 全量：force=true 跳过快速路径，走版本化目录 + 进度条从头重建。
      { label: "全量重建索引", action: () => codegraph.rebuild(rootPath) },
    );
  }
  return items;
}

// ── Session context menu ──

export function sessionMenuItems(
  id: string,
  onRenamed: (name: string) => void,
  onDeleted: () => void,
): MenuItem[] {
  const pane = usePaneLayout();
  return [
    // 混合 tab 布局：任意工作区的会话都可直接开 tab/分屏，cwd 跟会话归属走
    { label: "在新标签页打开", action: () => pane.openSessionInNewTab(id) },
    { label: "在右侧分屏打开", action: () => pane.openSessionInSplit(id, "horizontal") },
    { label: "在下方分屏打开", action: () => pane.openSessionInSplit(id, "vertical") },
    sep(),
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
        // 运行中的 sidecar 先杀掉，避免进程泄漏 & 删除后 jsonl 被重新写回
        await api.stopChatSession(id).catch(() => {});
        await api.deleteSession(id);
        pane.closeSessionTab(id); // 分屏里开着的 tab 一并关掉
        onDeleted();
      },
    },
  ];
}

// ── Workspace context menu（侧栏工作区行右键） ──

export function workspaceMenuItems(
  ws: { key: string; name: string; missing: boolean },
  onActivate?: () => void,
  onRemove?: () => void,
): MenuItem[] {
  return [
    ...(ws.missing ? [] : [{ label: "切换到此工作区", action: () => onActivate?.() }]),
    { label: "在文件资源管理器中打开", action: () => api.showInExplorer(ws.name) },
    { label: "复制路径", action: () => navigator.clipboard.writeText(ws.name) },
    sep(),
    {
      label: "从列表移除…",
      danger: true,
      action: () => onRemove?.(),
    },
  ];
}

// ── Pane tab context menu（聊天区分屏组的 tab 右键） ──

export function paneTabMenuItems(groupId: string, tabId: string): MenuItem[] {
  const pane = usePaneLayout();
  return [
    { label: "向右拆分", action: () => pane.splitFocusedGroup("horizontal", groupId) },
    { label: "向下拆分", action: () => pane.splitFocusedGroup("vertical", groupId) },
    sep(),
    { label: "关闭", action: () => pane.closeTab(groupId, tabId) },
    { label: "关闭其他", action: () => pane.closeOtherTabs(groupId, tabId) },
  ];
}
