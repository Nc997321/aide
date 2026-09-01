/**
 * L3 门控层：发送前确认的纯判定（provider respawn 维度）。
 *
 * 模型维度的门控已废除（2026-09-01-model-switch-truth-design.md §2）：模型切换
 * 的成本确认由 SDK PreModelSwitch hook 在切换发生前裁决（sidecar 挂起 → 前端弹窗），
 * 「上次发送的模型」基线对比是错位之源，已删除。
 *
 * 本文件只回答一件事：本次发送是否涉及**供应商 respawn**（进程重新拉起、历史迁移）。
 * 取 last=null 直接 false 的约定（无基线 = 首次 spawn / 未知，不弹）。
 *
 * 文案组装（provider name 查找、PermissionRequest 包装）不在此层——由 ChatPanel 拿
 * ConfirmDecision + allProviders 组装，保持本层零依赖、可纯函数测试。
 */

export interface ConfirmDecision {
  /** 本次发送将生效的供应商 id。 */
  effective: string;
  /** 上次发送坐实的供应商 id（needsConfirm 为 true 时必非 null）。 */
  last: string;
}

/** 是否弹发送前确认：`last=null`（首次 / 无基线）→ false；供应商不同 → true。 */
export function needsConfirm(effective: string, last: string | null): boolean {
  if (!last) return false;
  return effective !== last;
}

/** 判定 + 组装决策。无需确认（last=null 或同供应商）→ null。 */
export function buildConfirmDecision(effective: string, last: string | null): ConfirmDecision | null {
  if (!last || !needsConfirm(effective, last)) return null;
  return { effective, last };
}