import type { ChatEvent, ModelOption } from "./types.js";

/** 运行时切模型的最小能力面——query 对象只需要这一个方法，测试可用替身。 */
export interface ModelSettable {
  setModel(model: string): Promise<void>;
}

export interface ModelSwitchParams {
  /** 用户在下拉里选中的模型 value（不透明字符串，provider 解释语义）。 */
  model: string;
  /** 当前存活 query 的 setModel 能力；null = query 未起（出错重连窗口等）。 */
  query: ModelSettable | null;
  /** 当前下拉列表：回广播用，也用来把 value 翻成 displayName 喂回执文案。 */
  models: ModelOption[];
  /** 本地已坐实的当前模型——失败时回滚广播把下拉拉回这个值。 */
  currentModel: string;
  emit: (e: ChatEvent) => void;
  /** 坐实（运行时成功）或本地落账（query 未起）时回写调用方的 currentModel。 */
  commit: (model: string) => void;
}

/**
 * 处理用户的 set_model 请求：成败都有回声，绝不静默——
 *
 * - query 未起（重连窗口）：存本地，startLoop 建 query 时经 options.model 带上，
 *   立即广播同步下拉。与 applyPermissionMode 的「进程没起就存本地」语义对齐——
 *   此前 `currentQuery?.setModel()` 可选链短路，这种情况被静默丢弃，用户的选择
 *   凭空消失。
 * - query 在跑：走 SDK 运行时接口。成功 → 坐实 + 广播 + model_switch_result(ok)；
 *   失败（CLI 驳回，如模型名无效）→ 回滚广播把下拉拉回旧值 + model_switch_result
 *   (ok:false, error)。此前 `.catch(() => {})` 吞掉失败，UI 上成功/失败完全无法
 *   区分——用户切了模型却可能一直在用旧模型对话而毫无知觉。
 */
export function applyModelSwitch(p: ModelSwitchParams): void {
  // 空值/同值是 no-op：不坐实、不广播、不回执（下拉本来就没变化）。
  if (!p.model || p.model === p.currentModel) return;
  const display = p.models.find((m) => m.value === p.model)?.displayName ?? p.model;
  const broadcast = (current: string) =>
    p.emit({ type: "models_available", models: p.models, current });

  if (!p.query) {
    p.commit(p.model);
    broadcast(p.model);
    return;
  }
  // 成功链路零动作：坐实/广播/回执全部交给 PostModelSwitch 的 model_committed 链
  // （回执=事实）。SDK 不保证 setModel 在 hook deny 后必 reject——若 resolve 而无
  // PostModelSwitch 到达，此处的 commit/broadcast 会把「被拒的新模型」坐实进程账面，
  // 此后用户重选同一模型被同值守卫吞掉（永远切不过去）。
  p.query.setModel(p.model).catch((e: unknown) => {
    broadcast(p.currentModel);
    p.emit({
      type: "model_switch_result",
      ok: false,
      model: p.model,
      display,
      error: String((e as Error)?.message ?? e),
    });
  });
}
