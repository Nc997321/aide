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
 *   Rust，合并进刚落盘的报告。**补交发两趟**：恢复当拍一趟，+2.5s 再一趟
 *   ——observer 的回调排在恢复之后才跑，它的条目（以及被挤出直读缓冲的帧）
 *   要晚半步才到齐，只发一趟必缺（见 sendSupplement）；
 * - visibilitychange 时立即发一次心跳通报 hidden 状态，让 watchdog
 *   及时抑制（浏览器节流后台定时器会造成假断档）。
 *
 * 与业务代码零耦合：main.ts 一行 startDiagnostics() 启动，可整体摘除。
 * 经 @aide/sdk 门面调用诊断命令（API 门面是所有命令调用的唯一入口；
 * 传输层注入让桩件/远端语义与业务命令一致）。
 */

import { api } from "../api";
import { drainMaxLag, startLagSampler } from "../utils/diagnostics/eventLoopLag";
import {
  drainSummary,
  entriesSinceDetailed,
  startLongTasks,
  type CaptureSource,
  type LongTaskEntry,
} from "../utils/diagnostics/longTasks";
import {
  drainWorstFrame,
  framesSinceDetailed,
  startLongFrames,
  type LongFrameEntry,
} from "../utils/diagnostics/longFrames";
import { readGauges } from "../utils/diagnostics/frontendState";
import { drainPending, snapshotAll, startBreadcrumbs } from "../utils/diagnostics/breadcrumbs";

/** 心跳周期。Rust watchdog 的判定阈值（2s）以此为基准，改动需两侧同步。 */
const HEARTBEAT_MS = 500;
/** 自愈补交阈值：与 Rust `FREEZE_GAP_MS` 对齐。 */
const FREEZE_GAP_MS = 2000;
/** 补交第二趟的延迟：observer 回调要在主线程恢复后才把条目喂进 ring，等它一步。 */
const SUPPLEMENT_PASS2_MS = 2500;
/** 补交取值余量：撞墙的肇事 longtask/帧往往在断档开始前就已启动。 */
const SUPPLEMENT_GUARD_MS = 1000;

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
    // 现场状态（挂了多少行/多少 DOM/堆多大）：与 longtask 时长合读，才答得上
    // 「那几秒在渲染什么」。字段必须在——读不到时是全 0 默认值，不是缺字段。
    gauges: readGauges(),
  };
  try {
    await api.diagHeartbeat(payload);
  } catch {
    // 诊断永不影响业务；调用失败（如启动早期）静默跳过
  }
}

/** 本场补交已攒下的现场：两趟之间取并集，保证第二趟 ⊇ 第一趟——Rust 侧是
 *  「后到覆盖先到」（frontend_supplement / merge_supplement 都是直接覆盖），
 *  第二趟若因缓冲挤出少带几条，覆盖等于把第一趟已拿到的现场又抹掉一次。
 *  新冻结的第一趟开始时清零（上一场的现场不能带进这一场）。 */
let supplementFrames: LongFrameEntry[] = [];
let supplementTasks: LongTaskEntry[] = [];
/** 本场两条路的来源自述（两趟取并，与 payload 里的数组同源）。 */
let supplementFrameSource: CaptureSource = "none";
let supplementTaskSource: CaptureSource = "none";

/** 按 key 取并集：同 key 只能同一条（时间戳为引擎给的起点），新值覆盖旧值。 */
function unionBy<T>(prev: T[], next: T[], key: (x: T) => number): T[] {
  const byKey = new Map<number, T>();
  for (const e of prev) byKey.set(key(e), e);
  for (const e of next) byKey.set(key(e), e);
  return [...byKey.values()].sort((a, b) => key(a) - key(b));
}

/** 两趟的来源取并：timeline∨ring 各自记一位——第二趟即使本趟读空，第一趟的
 *  条目还在 payload 里，来源就不能跟着报 none（自检第 ⑤ 项拿它判「有没有货」）。 */
function mergeSource(a: CaptureSource, b: CaptureSource): CaptureSource {
  const timeline = a === "timeline" || a === "both" || b === "timeline" || b === "both";
  const ring = a === "ring" || a === "both" || b === "ring" || b === "both";
  if (timeline && ring) return "both";
  return timeline ? "timeline" : ring ? "ring" : "none";
}

async function sendSupplement(gapMs: number, gapStartPerfMs: number, pass: number): Promise<void> {
  const since = gapStartPerfMs - SUPPLEMENT_GUARD_MS;
  const frames = framesSinceDetailed(since);
  const tasks = entriesSinceDetailed(since);
  supplementFrames = unionBy(supplementFrames, frames.frames, (f) => f.t);
  supplementTasks = unionBy(supplementTasks, tasks.tasks, (t) => t.start);
  supplementFrameSource = mergeSource(supplementFrameSource, frames.source);
  supplementTaskSource = mergeSource(supplementTaskSource, tasks.source);
  const payload = {
    gapMs: Math.round(gapMs),
    pass, // 第 1 趟 = 恢复当拍，第 2 趟 = +2.5s（后到覆盖先到，故第二趟是超集）
    // 本场冻结的身份（epoch ms ≈ 报告里的 freeze.started）：由「断档起点」在
    // performance.now 时间轴上反推。第二趟延迟 2.5s 才发，可能在新一场冻结已开始
    // 后才到——Rust 侧拿它比对挂靠报告，不匹配就整份丢弃（张冠李戴比缺失更坏）。
    freezeStartedMs: Math.round(Date.now() - (performance.now() - gapStartPerfMs)),
    longFrames: supplementFrames,
    longFramesSource: supplementFrameSource,
    longTasks: supplementTasks,
    longTasksSource: supplementTaskSource,
    gauges: readGauges(),
    crumbs: snapshotAll(),
  };
  try {
    await api.diagFreezeSupplement(payload);
  } catch {
    // 同上，静默
  }
}

let pass2Timer: ReturnType<typeof setTimeout> | null = null;

/** 补交一次冻结：同一个 gap 只点火一次，两趟共用一份累积现场。 */
function supplementFreeze(gapMs: number, gapStartPerfMs: number): void {
  supplementFrames = [];
  supplementTasks = [];
  supplementFrameSource = "none";
  supplementTaskSource = "none";
  void sendSupplement(gapMs, gapStartPerfMs, 1);
  if (pass2Timer) clearTimeout(pass2Timer);
  pass2Timer = setTimeout(() => {
    pass2Timer = null;
    void sendSupplement(gapMs, gapStartPerfMs, 2);
  }, SUPPLEMENT_PASS2_MS);
}

/** 启动黑匣子前端侧。幂等；随窗口生命周期常驻，无需停止。 */
export function startDiagnostics(): void {
  if (started) return;
  started = true;

  startLagSampler();
  startLongTasks();
  startLongFrames(); // 长帧归因：拆「脚本 / 样式布局 / 其余」+ 点名到函数（见 longFrames.ts）
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
      supplementFreeze(gap, gapStart);
    }
  }, HEARTBEAT_MS);
}
