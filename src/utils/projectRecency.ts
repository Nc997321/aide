/**
 * 侧栏「项目」排序与折叠（2026-10-17）：项目一多就找不到，所以和会话一样只露前 N 个
 * （设置「最近访问保留条数」），其余收进「另外 N 个」。
 *
 * 排序 = 最近一次会话活动倒序（发过消息的项目浮上来）；从没发过会话的排在后面，保持原有的名字序。
 * 当前项目（活动工作区）即使排在 N 之后也照样露出——否则正在用的项目会被藏起来。
 */
export interface ProjectLike {
  key: string;
}

/** 按活动时间倒序；活动时间相同（含都为 0）保持输入顺序（稳定排序）。 */
export function orderByRecency<T extends ProjectLike>(list: readonly T[], activity: (p: T) => number): T[] {
  return list
    .map((p, i) => ({ p, i, t: activity(p) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.p);
}

/** 折叠视图：前 limit 个 + 排在后面但必须露出的（keep）。hidden = 被收起的个数。 */
export function collapseProjects<T extends ProjectLike>(
  ordered: readonly T[],
  limit: number,
  keep: (p: T) => boolean,
): { shown: T[]; hidden: number } {
  const shown = ordered.filter((p, i) => i < limit || keep(p));
  return { shown, hidden: ordered.length - shown.length };
}
