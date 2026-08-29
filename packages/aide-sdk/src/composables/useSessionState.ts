import { reactive } from "vue";

// ── 正交双轴模型 ──────────────────────────────────────────────────────────────
// 会话状态被拆成两条互不干扰的轴，避免早期「一个 error 既表示可恢复错误又表示进程
// 死亡」的语义混用（活着却显示死了）。
//
//   活跃度轴 activity —— 进程存活时它在干嘛（沿用历史语义，众多转换监听依赖它）
//   健康度轴 health   —— 它健不健康（新增；stopped 即 dead，故 health 不含 dead）
//
// 状态点是两轴的一个纯投影（dotTone）。

/** 活跃度轴：stopped=进程没了 / running=生成中 / waiting=存活空闲 / attention=等权限。 */
export type SessionStatus = "stopped" | "running" | "waiting" | "attention";

/** 健康度轴：ok=正常 / warning=上轮可恢复错误(进程仍活) / stalled=疑似卡住。
 *  dead 不在此轴——进程死亡由 activity=stopped 表达，两轴在死亡处坍缩。 */
export type SessionHealth = "ok" | "warning" | "stalled";

/** 状态点投影色调：活跃度四态 + 健康度的红(warning)/橙(stalled)。 */
export type DotTone = SessionStatus | "warning" | "stalled";

/** 软超时阈值：running 且连续这么久无任何 chat-event → 判 stalled（疑似卡在 await
 *  等心跳抓不到的假死）。纯 UI 软提示，不杀进程；任何事件到达即自动回落。 */
const STALLED_MS = 90_000;

// 模块级 reactive 单例——跨 ChatPanel / SidebarLeft / 通知等共享同一份状态。
const state = reactive<Record<string, SessionStatus>>({});
const health = reactive<Record<string, SessionHealth>>({});
// 每会话一个软超时定时器（非 reactive，纯副作用句柄）。
const stalledTimers: Record<string, ReturnType<typeof setTimeout>> = {};

function clearStalled(id: string) {
  const t = stalledTimers[id];
  if (t) {
    clearTimeout(t);
    delete stalledTimers[id];
  }
}

export function useSessionState() {
  function setSessionState(id: string, status: SessionStatus) {
    state[id] = status;
    // 离开 running（waiting/attention/stopped）即停软超时：attention 期间用户可能
    // 长时间不答权限弹窗，不该误判卡住；waiting/stopped 也不需要计时。
    // 重新进入 running 由 armStalled 显式起表。
    if (status !== "running") clearStalled(id);
  }

  function setSessionHealth(id: string, h: SessionHealth) {
    health[id] = h;
  }

  function removeSessionState(id: string) {
    delete state[id];
    delete health[id];
    clearStalled(id);
  }

  /** 重置软超时定时器：running 期间每收到一个事件调用一次；超过 STALLED_MS 无事件
   *  则把 health 置 stalled。回调里再次校验 running，避免在已离开 running 后误触发。 */
  function armStalled(id: string) {
    clearStalled(id);
    stalledTimers[id] = setTimeout(() => {
      delete stalledTimers[id];
      if (state[id] === "running") health[id] = "stalled";
    }, STALLED_MS);
  }

  /** 状态点投影——单点颜色由两轴按优先级坍缩：
   *  dead(灰) > warning(红) > stalled(橙) > 活跃度(attention 黄/running 绿/waiting 蓝)。
   *  无条目默认 stopped（灰）。 */
  function dotTone(id: string): DotTone {
    const activity = state[id] ?? "stopped";
    if (activity === "stopped") return "stopped";
    const h = health[id] ?? "ok";
    if (h === "warning") return "warning";
    if (h === "stalled") return "stalled";
    return activity;
  }

  return {
    state,
    health,
    setSessionState,
    setSessionHealth,
    removeSessionState,
    armStalled,
    dotTone,
  };
}
