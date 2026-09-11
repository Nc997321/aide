import { reactive } from "vue";

// ── 正交双轴模型 ──────────────────────────────────────────────────────────────
// 会话状态被拆成两条互不干扰的轴，避免早期「一个 error 既表示可恢复错误又表示进程
// 死亡」的语义混用（活着却显示死了）。
//
//   活跃度轴 activity —— 进程存活时它在干嘛（沿用历史语义，众多转换监听依赖它）
//   健康度轴 health   —— 它健不健康（stopped 即 dead，故 health 不含 dead）
//
// 状态点是两轴的一个纯投影（dotTone）。
//
// 历史注：健康度轴曾有第三态 stalled（running 且 90s 无事件 → 橙点「疑似卡住」
// 软超时）。2026-09-11 用户定案撤销：长工具调用（构建/长命令）本来就可能几分钟
// 无事件，橙点把「正在干活」误报成「出问题」，且与 attention（等权限）的暖色
// 语义难以区分——运行态恒绿、等权限才有自己的颜色。卡死检测交回进程级通道：
// Rust 心跳看门狗（session_dead → stopped 灰点）+ 可恢复错误（warning 红点）。

/** 活跃度轴：stopped=进程没了 / running=生成中 / waiting=存活空闲 / attention=等权限。 */
export type SessionStatus = "stopped" | "running" | "waiting" | "attention";

/** 健康度轴：ok=正常 / warning=上轮可恢复错误(进程仍活)。
 *  dead 不在此轴——进程死亡由 activity=stopped 表达，两轴在死亡处坍缩。 */
export type SessionHealth = "ok" | "warning";

/** 状态点投影色调：活跃度四态 + 健康度的红(warning)。 */
export type DotTone = SessionStatus | "warning";

// 模块级 reactive 单例——跨 ChatPanel / SidebarLeft / 通知等共享同一份状态。
const state = reactive<Record<string, SessionStatus>>({});
const health = reactive<Record<string, SessionHealth>>({});
// 非交互式会话（自动化运行/蒸馏轮等，无用户面板）：session_init 时发现事件路由键
// 与 SDK 真实 id 不一致即可判定，标记后所有状态写入静默丢弃——不登记就不会产生
// 「永远收不到终态的孤儿 running 条目」。removeSessionState 时解除标记。
const untrackedSids = new Set<string>();

/** 标记一个会话为「不跟踪」：清掉已有条目，后续 setSessionState 全部 no-op。 */
export function markSessionUntracked(id: string) {
  untrackedSids.add(id);
  delete state[id];
  delete health[id];
}

/**
 * 是否「不跟踪」会话（自动化运行/蒸馏轮等无用户面板的来源）。
 *
 * 只读查询——旁路消费者（如变更归集）需要据此拒绝建桶：不跟踪会话没有轮次视图，
 * 归集进去的数据永远无人消费，只会在内存里堆积。
 */
export function isSessionUntracked(id: string): boolean {
  return untrackedSids.has(id);
}

export function useSessionState() {
  function setSessionState(id: string, status: SessionStatus) {
    if (untrackedSids.has(id)) return;
    state[id] = status;
  }

  function setSessionHealth(id: string, h: SessionHealth) {
    if (untrackedSids.has(id)) return;
    health[id] = h;
  }

  function removeSessionState(id: string) {
    untrackedSids.delete(id);
    delete state[id];
    delete health[id];
  }

  /** 状态点投影——单点颜色由两轴按优先级坍缩：
   *  dead(灰) > warning(红) > 活跃度(attention/running/waiting 各自色)。
   *  无条目默认 stopped（灰）。running 恒为绿（无软超时变色，见文件头历史注）。 */
  function dotTone(id: string): DotTone {
    const activity = state[id] ?? "stopped";
    if (activity === "stopped") return "stopped";
    const h = health[id] ?? "ok";
    if (h === "warning") return "warning";
    return activity;
  }

  return {
    state,
    health,
    setSessionState,
    setSessionHealth,
    removeSessionState,
    dotTone,
  };
}
