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

/** 文件树每级缩进（px）：行 padding 与 indent-guide 定位共用的事实源。 */
export const TREE_INDENT_PX = 18;
/** 行内容距左侧的基础留白（px），与 .tree-node 的 padding 基准一致。 */
export const TREE_ROW_BASE_PADDING_PX = 8;
/** 悬停左移时行内容距面板左缘的最小留白（px）——防止贴上 active bar/面板边缘。 */
const TREE_ROW_HOVER_MIN_PADDING_PX = 4;
/**
 * 悬停左移的拟合余量（px）：scrollWidth/clientWidth 是整数化测量，边界拟合
 * 最多差 ~1px，而 text-overflow: ellipsis 会把亚像素短缺放大成砍 1~2 个字符
 * （要给 "…" 腾位置）——多移 2px 保证完整显示。
 */
const TREE_HOVER_REVEAL_SLACK_PX = 2;

/** 正常态行 padding-left。 */
export function treeRowPaddingLeft(depth: number): number {
  return depth * TREE_INDENT_PX + TREE_ROW_BASE_PADDING_PX;
}

/**
 * 悬停截断名的按需左移：缺多少移多少（overflowPx + 拟合余量），一直移到名字
 * 完整显示为止。越过缩进参考线是有意设计——唯一上限是面板左缘：行 padding
 * 可全部用完，只留 TREE_ROW_HOVER_MIN_PADDING_PX 防贴边。名字比整个侧栏
 * 还宽时，剩余部分物理上放不下，仍截断。缺口 ≤1px 视为未截断（亚像素容差）。
 */
export function hoverRevealPaddingLeft(depth: number, overflowPx: number): number {
  if (overflowPx <= 1) return treeRowPaddingLeft(depth);
  const maxShift = treeRowPaddingLeft(depth) - TREE_ROW_HOVER_MIN_PADDING_PX;
  return treeRowPaddingLeft(depth) - Math.min(overflowPx + TREE_HOVER_REVEAL_SLACK_PX, maxShift);
}