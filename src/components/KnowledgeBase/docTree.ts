// 扁平文档列表 → 树查询（纯函数，不依赖 Vue）。
//
// 服务端 `/api/spaces/{id}/documents` 给的是扁平列表（id + parentId），树在客户端现算。
// 本模块是这份「树」的唯一算法产地：**侧栏缩进与删除确认弹窗都从这里取数**。
// 各算各的迟早漂移——侧栏缩进看着是 4 篇，弹窗却说「将连带删除 2 篇」。
import type { KbDocumentSummary } from "./kbClient";

/** 缩进上限：链再长也不继续往右推，否则深层文档会把侧栏挤没。 */
const MAX_DEPTH = 3;

/** parentId → 子文档 id 列表（列表里没有父的「孤儿」不会出现在任何一组里）。 */
function childrenOf(docs: KbDocumentSummary[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const d of docs) {
    if (d.parentId === null) continue;
    const siblings = map.get(d.parentId);
    if (siblings) siblings.push(d.id);
    else map.set(d.parentId, [d.id]);
  }
  return map;
}

/** 每篇文档的层级（顶层 0），沿 parentId 往上数，最多 MAX_DEPTH。 */
export function depthOf(docs: KbDocumentSummary[]): Record<string, number> {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out: Record<string, number> = {};
  for (const d of docs) out[d.id] = depthOfOne(d, byId);
  return out;
}

function depthOfOne(doc: KbDocumentSummary, byId: Map<string, KbDocumentSummary>): number {
  let depth = 0;
  let cur = doc.parentId === null ? undefined : byId.get(doc.parentId);
  while (cur && depth < MAX_DEPTH) {
    depth++;
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return depth;
}

/**
 * `rootId` 及其全部子孙的篇数（**含根自己**——与删除接口回执的 `deletedCount` 同口径）。
 * `rootId` 不在列表里 → 0：列表是当前空间的可读视图，可能已不含它。
 *
 * `seen` 挡的不只是重复计数：parentId 是用户数据，成环（a→b→a）时必须原地停下，
 * 否则这里直接把 UI 挂死。
 */
export function subtreeSize(docs: KbDocumentSummary[], rootId: string): number {
  if (!docs.some((d) => d.id === rootId)) return 0;

  const children = childrenOf(docs);
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of children.get(id) ?? []) walk(child);
  };
  walk(rootId);

  return seen.size;
}
