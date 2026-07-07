/**
 * 卡死诊断黑匣子——前端采集主控。
 *
 * 设计文档：docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md
 *
 * 职责：
 * - 启动三个采集器（event loop 延迟 / longtask / 面包屑）；
 * - 每 500ms 向 Rust 发一次心跳（携带本周期指标增量）——Rust watchdog
 *   以心跳断流 ≥2s 判定冻结；
 * - 自愈补交：心跳定时器自己发现断档 ≥2s（= 刚从卡死中恢复），把冻结
 *   期间 PerformanceObserver 攒下的 longtask 明细 + 面包屑快照补交给
 *   Rust，合并进刚落盘的报告；
 * - visibilitychange 时立即发一次心跳通报 hidden 状态，让 watchdog
 *   及时抑制（浏览器节流后台定时器会造成假断档）。
 *
 * 与业务代码零耦合：main.ts 一行 startDiagnostics() 启动，可整体摘除。
 * 直接 invoke 而不走 api.ts——诊断是基础设施层（同 main.ts 的错误上报），
 * 不属于业务 API 面。
 */

import { invoke } from "@tauri-apps/api/core";
import { drainMaxLag, startLagSampler } from "../utils/diagnostics/eventLoopLag";
import { drainSummary, entriesSince, startLongTasks } from "../utils/diagnostics/longTasks";
import { drainPending, snapshotAll, startBreadcrumbs } from "../utils/diagnostics/breadcrumbs";

/** 心跳周期。Rust watchdog 的判定阈值（2s）以此为基准，改动需两侧同步。 */
const HEARTBEAT_MS = 500;
/** 自愈补交阈值：与 Rust `FREEZE_GAP_MS` 对齐。 */
const FREEZE_GAP_MS = 2000;

let started = false;
/** 上一次心跳 tick 的 performance.now() */
let lastBeatAt = 0;
/** 最近一次 visibilitychange 的 performance.now()（区分卡死与后台节流） */
let lastVisibilityChangeAt = -Infinity;

async function sendHeartbeat(): Promise<void> {
  const longTasks = drainSummary();
  const payload = {
    lagMaxMs: drainMaxLag(),
    longTaskCount: longTasks.count,
    longTaskMaxMs: longTasks.maxMs,
    crumbs: drainPending(),
    hidden: document.hidden,
  };
  try {
    await invoke("diag_heartbeat", { payload });
  } catch {
    // 诊断永不影响业务；invoke 失败（如启动早期）静默跳过
  }
}

async function sendSupplement(gapMs: number, gapStartPerfMs: number): Promise<void> {
  const payload = {
    gapMs: Math.round(gapMs),
    // 多取 1s 余量：卡死的肇事 longtask 往往在断档开始前就已启动
    longTasks: entriesSince(gapStartPerfMs - 1000),
    crumbs: snapshotAll(),
  };
  try {
    await invoke("diag_freeze_supplement", { payload });
  } catch {
    // 同上，静默
  }
}

/** 启动黑匣子前端侧。幂等；随窗口生命周期常驻，无需停止。 */
export function startDiagnostics(): void {
  if (started) return;
  started = true;

  startLagSampler();
  startLongTasks();
  startBreadcrumbs();

  lastBeatAt = performance.now();

  document.addEventListener("visibilitychange", () => {
    lastVisibilityChangeAt = performance.now();
    void sendHeartbeat();
  });

  setInterval(() => {
    const now = performance.now();
    const gap = now - lastBeatAt;
    const gapStart = lastBeatAt;
    lastBeatAt = now;
    void sendHeartbeat();

    // 自愈补交：断档 ≥ 阈值说明渲染线程刚从卡死中恢复。
    // 排除后台节流假象：断档期间有过 visibilitychange、或当前仍隐藏，都不补交
    //（watchdog 侧同样抑制了 hidden 期间的判定，两边口径一致）。
    if (
      gap >= FREEZE_GAP_MS &&
      !document.hidden &&
      lastVisibilityChangeAt < gapStart
    ) {
      void sendSupplement(gap, gapStart);
    }
  }, HEARTBEAT_MS);
}
