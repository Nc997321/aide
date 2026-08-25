import type { MenuItem } from "../composables/useContextMenu";
import { useModal } from "../composables/useModal";
import { useFileViewer } from "../composables/useFileViewer";
import { useFileClipboard, getParentPath } from "../composables/useFileClipboard";
import { usePaneLayout } from "../composables/usePaneLayout";
import { useMentionInserter } from "../composables/useMentionInserter";
import { api } from "../api";

function sep(): MenuItem {
  return { label: "", separator: true };
}

const modal = useModal();
const cb = useFileClipboard();
const mentionInserter = useMentionInserter();

// ── File context menu ──

export function fileMenuItems(
  path: string,
  projectRoot: string,
  onDeleted?: () => void,
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
    { label: "添加到对话", action: () => mentionInserter.insertMention(path, false) },
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
  callbacks: {
    onToggle?: () => void;
    onRefresh?: () => void;
    onDeleted?: () => void;
    /** 粘贴时刷新「剪切源」所在目录（不同于本目录的 onRefresh） */
    refreshDir?: (dirPath: string) => void;
  },
): MenuItem[] {
  const { onToggle, onRefresh, onDeleted, refreshDir } = callbacks;
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
    { label: "添加到对话", action: () => mentionInserter.insertMention(path, true) },
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
  callbacks: {
    onRenamed: (name: string) => void;
    onOptimisticRemove: () => void;
    onDeleteFailed: () => void;
  },
): MenuItem[] {
  const { onRenamed, onOptimisticRemove, onDeleteFailed } = callbacks;
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
        // 乐观移除：确认后先把卡片从列表里拿掉（离场动画即刻开始），
        // 后台再真正删除；失败由 onDeleteFailed 回滚列表 + 报错。
        onOptimisticRemove();
        try {
          // 运行中的 sidecar 先杀掉，避免进程泄漏 & 删除后 jsonl 被重新写回
          await api.stopChatSession(id).catch(() => {});
          await api.deleteSession(id);
        } catch {
          onDeleteFailed();
          return;
        }
        pane.closeSessionTab(id); // 分屏里开着的 tab 一并关掉
      },
    },
  ];
}

// ── Sidebar section menu（侧栏分区导航行 ⋯ 菜单）──

/** 「会话」导航行 ⋯：新建入口从分区头 ＋ 按钮收进此处（右槽位 计数⇄⋯ 交互）。 */
export function sessionSectionMenuItems(onNewSession: () => void): MenuItem[] {
  return [{ label: "新建会话", kbd: "Ctrl+N", action: onNewSession }];
}

/** 「自动化」导航行 ⋯：同上，新建任务入口。 */
export function automationSectionMenuItems(onNewTask: () => void): MenuItem[] {
  return [{ label: "新建自动化任务", action: onNewTask }];
}

// ── Workspace context menu（侧栏工作区行右键/⋯ 共用） ──

export function workspaceMenuItems(
  ws: { key: string; name: string; missing: boolean },
  onActivate?: () => void,
  onRemove?: () => void,
  /** 仅不受信任工作区传入：菜单提供信任入口（行内已不放「不受信任」文字徽标） */
  onTrust?: () => void,
): MenuItem[] {
  return [
    ...(ws.missing ? [] : [{ label: "切换到此工作区", action: () => onActivate?.() }]),
    ...(onTrust ? [{ label: "信任此工作区", warning: true, action: onTrust }] : []),
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
    { label: "关闭", action: () => { void pane.closeTab(groupId, tabId); } },
    { label: "关闭其他", action: () => { void pane.closeOtherTabs(groupId, tabId); } },
  ];
}
