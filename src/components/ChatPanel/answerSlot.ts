/**
 * 作答槽仲裁（2026-10-16 会话组成重排）：「需要你回应」的东西只有一个位置，
 * 同一时刻只出一张卡，其余计入「另有 N 条」。
 *
 * 优先级 = 阻塞程度：本会话的权限队列（含发送前确认，会话停在那里等你）> 子会话在等批准
 * （引导卡，点「去处理」到子会话里批——v1 不代批）> 语言服务器询问（不阻塞，消息已经发出去了）。
 * 让位的计入「还有 N 条」。
 */
export type AnswerKind = "permission" | "subsession" | "lsp";

export interface AnswerSources {
  /** 当前显示的权限 / 确认请求是否存在 */
  permission: boolean;
  /** 挂起的权限请求总数（含当前那条；发送前确认算 1） */
  permissionCount: number;
  /** 语言服务器询问是否待答 */
  lsp: boolean;
  /** 在等批准的子会话数（每个算一条） */
  subsessionWaiting?: number;
}

export interface AnswerPick {
  kind: AnswerKind | null;
  /** 全部待作答数（含正在显示的这张） */
  total: number;
}

export function pickAnswer(s: AnswerSources): AnswerPick {
  const permissionCount = s.permission ? Math.max(1, s.permissionCount) : 0;
  const waiting = s.subsessionWaiting ?? 0;
  const total = permissionCount + waiting + (s.lsp ? 1 : 0);
  if (permissionCount > 0) return { kind: "permission", total };
  if (waiting > 0) return { kind: "subsession", total };
  if (s.lsp) return { kind: "lsp", total };
  return { kind: null, total: 0 };
}
