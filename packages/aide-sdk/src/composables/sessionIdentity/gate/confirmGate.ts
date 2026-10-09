/**
 * L3 门控层：发送前确认的判定入口。
 *
 * 判定规则 2026-09-08 起下沉 Rust（`src-tauri/src/commands/session::compute_identity_drift`）：
 * 规则只此一份，桌面端与鸿蒙端（ArkTS 无 aide-sdk 可复用）共用，本层不再本地
 * 实现比较逻辑——只负责调用，并判定「要不要弹」。
 *
 * **两维都判，先供应商、再模型**：两者都相同才不弹窗。
 *  - 供应商漂移：要 respawn（进程原地 resume 重拉、提示缓存失效），代价大，文案必须说清是永久改动；
 *  - 仅模型漂移：供应商没换，只换模型，文案侧重模型本身。
 *
 * 修订记录：2026-09-01 曾废除模型维度（只判供应商），理由是「上次发送的模型基线
 * 对比是错位之源」；2026-09-08 恢复——未启动的旧会话点开后模型跟全局走、不跟会话
 * 记忆（与供应商同口径），此时发送若不提示，用户不知道模型已经换了。
 *
 * 基线由 Rust 从会话元数据 `<id>.json` 读（与 sessionProvider / sessionModel
 * 同一口径）；基线缺失 → 该维度 false（无基线不弹）。判定调用失败 → 放行（null），
 * 不因门控自身故障卡住发送。
 */

import { api } from "../../../api";

export interface ConfirmDecision {
  /** 本次发送将生效的供应商 id。 */
  effective: string;
  /** 会话记住的供应商 id（无 → null）。 */
  last: string | null;
  /** 本次发送将生效的模型。 */
  effectiveModel: string;
  /** 会话记住的模型（无 → null）。 */
  lastModel: string | null;
  /** 供应商维度漂移（true = 需要 respawn）。 */
  providerDrift: boolean;
  /** 模型维度漂移。 */
  modelDrift: boolean;
}

/**
 * 判定本次发送是否要弹确认。无需确认（两维都相同 / 无基线 / 查询失败）→ null。
 */
export async function buildConfirmDecision(
  sid: string,
  effective: string,
  effectiveModel: string,
): Promise<ConfirmDecision | null> {
  // 判空不是防御性冗余：transport 未实现该命令时（测试替身 / 旧版主进程）会
  // resolve 出 undefined，判空缺失会让门控抛错、进而卡住发送路径。
  let drift: Awaited<ReturnType<typeof api.sessionIdentityDrift>> | null = null;
  try {
    drift = await api.sessionIdentityDrift(sid, effective, effectiveModel);
  } catch {
    return null; // 门控自身故障不阻塞发送
  }
  if (!drift || (!drift.providerDrift && !drift.modelDrift)) {
    return null;
  }
  return {
    effective,
    last: drift.lastProvider,
    effectiveModel,
    lastModel: drift.lastModel,
    providerDrift: drift.providerDrift,
    modelDrift: drift.modelDrift,
  };
}
