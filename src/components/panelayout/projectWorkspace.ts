/**
 * 「工程」模式新会话的默认归属。
 *
 * 日常目录**不能**当工程归属：模式的选中态是从归属派生的（归属 = 日常目录 → 日常），
 * 把它绑给工程会话等于点了「工程」又被判回「日常」。2026-10-10 起日常目录可以被手动切成
 * 活动工作区，所以「拿当前活动工作区当工程归属」不再恒成立——这里是唯一的挑选规则。
 *
 * 顺序：活动工作区（不是日常时）→ 工作区列表里第一个可用的 → 不绑（hero 上就地选）。
 */
export interface WorkspaceBind {
  wsKey: string;
  wsPath: string;
}

export function pickProjectWorkspace(
  active: WorkspaceBind | undefined,
  workspaces: readonly { key: string; name: string; missing?: boolean }[],
  isDaily: (key: string) => boolean,
): WorkspaceBind | undefined {
  if (active && !isDaily(active.wsKey)) return active;
  const first = workspaces.find((w) => !w.missing && !!w.key && !!w.name && !isDaily(w.key));
  return first ? { wsKey: first.key, wsPath: first.name } : undefined;
}
