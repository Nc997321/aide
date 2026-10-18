/**
 * 会话列表的父子嵌套（纯函数层）：子会话（Session.parentId 指向列表内的会话）紧跟
 * 父会话、按深度缩进。对照桌面「子会话挂在父会话下」（协议 §8.1：list_sessions 条目
 * 带可选 parentId）。
 *
 * - 父会话不在列表里（被过滤 / 已删 / 跨工作区）→ 子会话按根平铺，不丢。
 * - 环（parentId 互指）由 seen 集合截断，每个会话只出现一次。
 */
import { Session } from '../sdk/types';

export interface SessionRow {
  s: Session;
  /** 0 = 根；1 = 子会话（子会话的子会话同理递增）。 */
  depth: number;
}

export function nestSessions(list: Session[]): SessionRow[] {
  const present: Set<string> = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    present.add(list[i].id);
  }
  const kids: Map<string, Session[]> = new Map<string, Session[]>();
  const roots: Session[] = [];
  for (let i = 0; i < list.length; i++) {
    const s: Session = list[i];
    const pid: string = s.parentId ?? '';
    if (pid !== '' && present.has(pid) && pid !== s.id) {
      const bucket: Session[] | undefined = kids.get(pid);
      if (bucket !== undefined) {
        bucket.push(s);
      } else {
        kids.set(pid, [s]);
      }
    } else {
      roots.push(s);
    }
  }
  const out: SessionRow[] = [];
  const seen: Set<string> = new Set<string>();
  for (let i = 0; i < roots.length; i++) {
    emitTree(roots[i], 0, kids, seen, out);
  }
  // 环上的会话既不是根也到不了（父互指）：兜底按根补出，不让它从列表里消失
  for (let i = 0; i < list.length; i++) {
    emitTree(list[i], 0, kids, seen, out);
  }
  return out;
}

/** 深度优先输出一棵子树（seen 截环；按列表原序保持稳定）。 */
function emitTree(s: Session, depth: number, kids: Map<string, Session[]>, seen: Set<string>,
  out: SessionRow[]): void {
  if (seen.has(s.id)) {
    return;
  }
  seen.add(s.id);
  out.push({ s: s, depth: depth });
  const children: Session[] | undefined = kids.get(s.id);
  if (children === undefined) {
    return;
  }
  for (let i = 0; i < children.length; i++) {
    emitTree(children[i], depth + 1, kids, seen, out);
  }
}
