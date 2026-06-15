import { invoke } from "@tauri-apps/api/core";
import type { MenuItem } from "../composables/useContextMenu";
import { useModal } from "../composables/useModal";

function sep(): MenuItem {
  return { label: "", separator: true };
}

const modal = useModal();

// ── File context menu ──

export function fileMenuItems(
  path: string,
  projectRoot: string,
  onDeleted?: () => void,
): MenuItem[] {
  const fileName = path.split(/[/\\]/).pop() || path;
  return [
    { label: "打开", action: () => invoke("file_open", { path }) },
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
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm("删除文件", `确定要删除「${fileName}」吗？`, "删除", true);
        if (!ok) return;
        await invoke("delete_file", { path });
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
): MenuItem[] {
  const dirName = path.split(/[/\\]/).pop() || path;
  return [
    { label: "展开/折叠", action: onToggle },
    { label: "复制路径", action: () => navigator.clipboard.writeText(path) },
    sep(),
    {
      label: "新建文件",
      action: async () => {
        const name = await modal.prompt("新建文件", "输入文件名...", "创建");
        if (!name) return;
        await invoke("create_file", { parentPath: path, name });
        onRefresh?.();
      },
    },
    {
      label: "新建文件夹",
      action: async () => {
        const name = await modal.prompt("新建文件夹", "输入文件夹名...", "创建");
        if (!name) return;
        await invoke("create_dir", { parentPath: path, name });
        onRefresh?.();
      },
    },
    sep(),
    {
      label: "删除",
      danger: true,
      action: async () => {
        const ok = await modal.confirm("删除文件夹", `确定要删除「${dirName}」及其所有内容吗？`, "删除", true);
        if (!ok) return;
        await invoke("delete_file", { path });
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
        await invoke("create_file", { parentPath: rootPath, name });
        onRefresh();
      },
    },
    {
      label: "新建文件夹",
      action: async () => {
        const name = await modal.prompt("新建文件夹", "输入文件夹名...", "创建");
        if (!name) return;
        await invoke("create_dir", { parentPath: rootPath, name });
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
        const ok = await modal.confirm("删除会话", "确定要删除此会话吗？此操作不可撤销。", "删除", true);
        if (!ok) return;
        await invoke("delete_session", { id });
        onDeleted();
      },
    },
  ];
}
