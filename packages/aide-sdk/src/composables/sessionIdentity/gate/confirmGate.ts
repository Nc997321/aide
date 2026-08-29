/**
 * L3 门控层：发送前确认的纯判定。零副作用、零依赖（不碰 IPC / 注册表 / 响应式）。
 *
 * 取代 useSessionContinuity.needsConfirm + ChatPanel.buildSendConfirmRequest 的判定部分。
 * 本次 bug 现场：旧 needsConfirm 把 `lastUsedModel=null` 经 `?? ""` 抹成空串与真实模型比
 * → 误弹"切换模型"。这里 `last=null` 直接返回 false（无基线 = 首次 spawn / 未知，不弹），
 * 不再做 `?? ""` 兜底——null 与 "空串" 语义分离是治本点之一。
 *
 * 文案组装（provider name 查找、PermissionRequest 包装）不在此层——由 ChatPanel 拿
 * ConfirmDecision + allProviders 组装，保持本层零依赖、可纯函数测试。
 */

export interface Identity {
  provider: string;
  model: string;
}

export type ConfirmChanged = "provider" | "model" | "both";

export interface ConfirmDecision {
  changed: ConfirmChanged;
  effective: Identity;
  /** needsConfirm 为 true 时 last 必非 null。 */
  last: Identity;
}

/** 是否弹发送前确认：`last=null`（首次 / 无基线）→ false；provider 或 model 与上次不同 → true。
 *  不再做 `last ?? ""` 兜底——null 是"没基线可比"，不是"上次用空模型"。 */
export function needsConfirm(effective: Identity, last: Identity | null): boolean {
  if (!last) return false;
  if (effective.provider !== last.provider) return true;
  if (effective.model !== last.model) return true;
  return false;
}

/** 判定 + 切换类型。无需确认（last=null 或全同）→ null；否则返回 changed 类型 + 新旧身份，
 *  供 ChatPanel 组装确认弹窗文案（title/question/info 按 changed 分支）。 */
export function buildConfirmDecision(effective: Identity, last: Identity | null): ConfirmDecision | null {
  if (!last || !needsConfirm(effective, last)) return null;
  const providerChanged = effective.provider !== last.provider;
  const modelChanged = effective.model !== last.model;
  const changed: ConfirmChanged = providerChanged && modelChanged
    ? "both"
    : providerChanged
      ? "provider"
      : "model";
  return { changed, effective, last };
}