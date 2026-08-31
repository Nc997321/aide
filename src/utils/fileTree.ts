import type { FileEntry } from "../types";

/**
 * 目录列表的按路径合并——刷新不闪的关键（FileTree.refreshAllExpanded /
 * refreshDir / loadChildren 共用）。
 *
 * 背景：刷新若整体替换 children（新条目对象里子目录的 children 全是 null），
 * 已展开的子目录会跌进 `isExpanded && node.children` 为 false 的过渡态——
 * 子列表 DOM 立即卸载，等逐层补加载的 IPC 间隙过去才重挂载，视觉上就是
 * "整棵工作树闪一下"的重挂载波。合并语义让对象身份（引用）在刷新中存活：
 *
 * - 同路径且 is_dir 未变的条目 → 复用旧对象（Vue 按key复用组件、其已加载
 *   的 children 原样保留，展开态不受刷新影响）
 * - 新路径 → 用新对象
 * - 已消失的路径 → 剔除（不在新 entries 里自然出局）
 * - is_dir 翻转（目录被删、同名文件顶替）→ 不许复用，必须换新对象，
 *   否则旧 is_dir/children 残留成幽灵节点
 * - 输出顺序完全跟随 entries（后端排序是单一事实源）
 */
export function mergeFileEntries(oldList: FileEntry[] | null, entries: FileEntry[]): FileEntry[] {
  const byPath = new Map((oldList ?? []).map((n) => [n.path, n]));
  return entries.map((e) => {
    const prev = byPath.get(e.path);
    return prev && prev.is_dir === e.is_dir ? prev : e;
  });
}