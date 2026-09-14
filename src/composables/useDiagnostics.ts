/**
 * 卡死诊断黑匣子——前端采集主控。
 *
 * 设计文档：docs/superpowers/specs/2026-07-08-freeze-diagnostics-design.md
 *
 * 职责：
 * - 启动采集器（event loop 延迟 / longtask / 面包屑 / 滚动诊断环）；
 * - 每 500ms 向 Rust 发一次心跳（携带本周期指标增量）——Rust watchdog
 *   以心跳断流 ≥2s 判定冻结；
 * - 自愈补交：心跳定时器自己发现断档 ≥2s（= 刚从卡死中恢复），把冻结
 *   期间 PerformanceObserver 攒下的 longtask 明细 + 面包屑快照补交给
 *   Rust，合并进刚落盘的报告；
 * - visibilitychange 时立即发一次心跳通报 hidden 状态，让 watchdog
 *   及时抑制（浏览器节流后台定时器会造成假断档）。
 *
 * 与业务代码零耦合：main.ts 一行 startDiagnostics() 启动，可整体摘除。
 * 经 @aide/sdk 门面调用诊断命令（API 门面是所有命令调用的唯一入口；
 * 传输层注入让桩件/远端语义与业务命令一致）。
 */

import { api } from "../api";
import { drainMaxLag, startLagSampler } from "../utils/diagnostics/eventLoopLag";
import { drainSummary, entriesSince, startLongTasks } from "../utils/diagnostics/longTasks";
import { drainWorstFrame, framesSince, startLongFrames } from "../utils/diagnostics/longFrames";
import { drainPending, snapshotAll, startBreadcrumbs } from "../utils/diagnostics/breadcrumbs";
import { startScrollTrail } from "../utils/diagnostics/scrollTrail";

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
  // 长帧只带「本周期最长那一帧」：它才是撞墙的肇事帧，整周期明细体积不可控。
  // 这一帧带脚本/样式布局/其余的分解 + 强制同步布局耗时 + 函数名（见 longFrames.ts）。
  const frames = drainWorstFrame();
  const payload = {
    lagMaxMs: drainMaxLag(),
    longTaskCount: longTasks.count,
    longTaskMaxMs: longTasks.maxMs,
    crumbs: drainPending(),
    hidden: document.hidden,
    frames,
  };
  try {
    await api.diagHeartbeat(payload);
  } catch {
    // 诊断永不影响业务；调用失败（如启动早期）静默跳过
  }
}

async function sendSupplement(gapMs: number, gapStartPerfMs: number): Promise<void> {
  const payload = {
    gapMs: Math.round(gapMs),
    // 多取 1s 余量：卡死的肇事 longtask 往往在断档开始前就已启动
    longTasks: entriesSince(gapStartPerfMs - 1000),
    // 长帧全量明细（含每帧的脚本归因）——补交是低频路径，体积不限
    longFrames: framesSince(gapStartPerfMs - 1000),
    crumbs: snapshotAll(),
  };
  try {
    await api.diagFreezeSupplement(payload);
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
  startLongFrames(); // 长帧归因：拆「脚本 / 样式布局 / 其余」+ 点名到函数（见 longFrames.ts）
  startBreadcrumbs();
  startScrollTrail(); // 滚动诊断环：间歇性滚轮定格的活体采集（见 scrollTrail.ts）

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
