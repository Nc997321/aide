// 扁平文档列表 → 树（纯函数，不依赖 Vue）。
//
// 服务端 `/api/spaces/{id}/documents` 给的是扁平列表（id + parentId + kind），
// 树在客户端现算。本模块是这份「树」的唯一算法产地：**侧栏渲染、折叠、删除确认
// 弹窗、搜索跳转都从这里取数**。各算各的迟早漂移——侧栏看着是 4 篇，
// 弹窗却说「将连带删除 2 篇」。
import type { KbDocumentSummary } from "./kbClient";

/** 树节点。`doc` 保留原始摘要，渲染层不用再回头查。 */
export interface KbTreeNode {
  doc: KbDocumentSummary;
  children: KbTreeNode[];
  isFolder: boolean;
}

/** 摊平后的一行：`depth` 直接当缩进用，折叠的子树不产出。 */
export interface VisibleRow {
  doc: KbDocumentSummary;
  depth: number;
  isFolder: boolean;
  /** 只是「有没有子节点」，与当前折没折叠无关——决定折叠箭头显不显示 */
  hasChildren: boolean;
}

/** kind 缺省当文档：老服务端没有这个字段，降级不能让节点变成文件夹。 */
function isFolder(doc: KbDocumentSummary): boolean {
  return doc.kind === "folder";
}

/**
 * 同级排序：**文件夹优先，各自按名称升序**。
 *
 * 用 `localeCompare` 而不是 `<`：中文要按拼音排才对（`<` 比的是码位，
 * 汉字会排成一团乱序）。`id` 兜底保证同名的两个节点顺序稳定。
 */
function compareNodes(a: KbDocumentSummary, b: KbDocumentSummary): number {
  if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
  return a.title.localeCompare(b.title, "zh") || a.id.localeCompare(b.id);
}

/**
 * 扁平列表 → 树。
 *
 * 两条必须写进实现的不变量：
 *
 * 1. **孤儿提升到根**：`parentId` 指向的节点不在列表里（父不可读 / 已删 / 数据异常）时，
 *    该节点作为根渲染。列表是「当前用户可读的视图」，父不可读而子可读是合法状态——
 *    **不能让任何一篇文档消失**。
 *
 * 2. **成环保护**：`parentId` 是用户数据，`a→b→a` 必须原地停下。这里比「挂之前验一次」
 *    多走一步：环上**每个**节点都有父，所以第一遍挂边时它们一个都进不了根集——
 *    光靠「验一次再挂」整条环会从树里消失。所以第二遍把「从根走不到的」逐个提为根。
 */
export function buildTree(docs: KbDocumentSummary[]): KbTreeNode[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const children = new Map<string, KbDocumentSummary[]>();
  const roots: KbDocumentSummary[] = [];

  // ① 挂边。父在列表里（且不是自己）就挂过去，否则进根集
  for (const d of docs) {
    const parent = d.parentId === null ? undefined : byId.get(d.parentId);
    if (!parent || parent.id === d.id) {
      roots.push(d);
      continue;
    }
    const siblings = children.get(parent.id);
    if (siblings) siblings.push(d);
    else children.set(parent.id, [d]);
  }

  // ② 从根走一遍，把够不着的（成环的那些）逐个提为根。visited 让环原地停下。
  const visited = new Set<string>();
  const adopt = (d: KbDocumentSummary): void => {
    if (visited.has(d.id)) return;
    visited.add(d.id);
    for (const child of children.get(d.id) ?? []) adopt(child);
  };
  for (const r of roots) adopt(r);
  for (const d of docs) {
    if (visited.has(d.id)) continue;
    roots.push(d);
    adopt(d);
  }

  // ③ 成形 + 排序。`built` 同时兜住递归：环上的节点在 ② 里已被拆开，
  //    但万一还有残留，`built` 会在第二次遇到时把它挡掉，不会无限递归。
  const built = new Set<string>();
  const build = (d: KbDocumentSummary): KbTreeNode => {
    built.add(d.id);
    return {
      doc: d,
      isFolder: isFolder(d),
      children: (children.get(d.id) ?? [])
        .filter((c) => !built.has(c.id))
        .sort(compareNodes)
        .map(build),
    };
  };

  return roots.sort(compareNodes).map(build);
}

/** 摊平成可见行。`collapsed` 里的节点不展开其子树。 */
export function flatten(nodes: KbTreeNode[], collapsed: ReadonlySet<string>): VisibleRow[] {
  const out: VisibleRow[] = [];
  const walk = (list: KbTreeNode[], depth: number): void => {
    for (const n of list) {
      out.push({ doc: n.doc, depth, isFolder: n.isFolder, hasChildren: n.children.length > 0 });
      if (!collapsed.has(n.doc.id)) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/** 祖先链，从最近的父开始。搜索跳转时用它展开路径。成环时原地停下。 */
export function ancestorIds(docs: KbDocumentSummary[], id: string): string[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const start = byId.get(id);
  if (!start) return [];

  const chain: string[] = [];
  const visited = new Set<string>([id]);
  let cur = start.parentId === null ? undefined : byId.get(start.parentId);
  while (cur && !visited.has(cur.id)) {
    chain.push(cur.id);
    visited.add(cur.id);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return chain;
}

/** 每篇文档的层级（顶层 0）。由树派生——层级与排序必须来自同一棵树。 */
export function depthOf(docs: KbDocumentSummary[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of flatten(buildTree(docs), new Set())) out[row.doc.id] = row.depth;
  return out;
}

/**
 * `rootId` 及其全部子孙的数量（**含根自己**——与删除接口回执的 `deletedCount` 同口径）。
 * `rootId` 不在列表里 → 0：列表是当前空间的可读视图，可能已不含它。
 *
 * 走树而不是自己再遍历一次 parentId：成环时 `buildTree` 已经把环拆开了，
 * 这里拿到的必然是一棵正经的树，不会再撞上环。
 */
export function subtreeSize(docs: KbDocumentSummary[], rootId: string): number {
  const find = (nodes: KbTreeNode[]): KbTreeNode | undefined => {
    for (const n of nodes) {
      if (n.doc.id === rootId) return n;
      const hit = find(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  const root = find(buildTree(docs));
  if (!root) return 0;

  const count = (n: KbTreeNode): number => 1 + n.children.reduce((sum, c) => sum + count(c), 0);
  return count(root);
}
