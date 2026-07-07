/**
 * event loop 延迟采样器：100ms 定时器的实际漂移 = 主线程被占用的时长。
 *
 * 纯状态层，无 DOM 依赖。心跳周期内只保留最大值（黑匣子关心尖峰，
 * 不关心均值），drain 时取走并清零。
 */

const INTERVAL_MS = 100;

let timer: ReturnType<typeof setInterval> | null = null;
let last = 0;
let maxLagMs = 0;

export function startLagSampler(): void {
  if (timer !== null) return;
  last = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - INTERVAL_MS;
    if (lag > maxLagMs) maxLagMs = lag;
    last = now;
  }, INTERVAL_MS);
}

export function stopLagSampler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  maxLagMs = 0;
}

/** 取走本周期最大延迟（ms，取整、不为负）并清零。 */
export function drainMaxLag(): number {
  const v = maxLagMs;
  maxLagMs = 0;
  return Math.max(0, Math.round(v));
}
