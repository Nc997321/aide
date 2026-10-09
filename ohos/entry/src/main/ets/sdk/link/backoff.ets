/**
 * 重连退避（镜像桌面 relay.rs 已修语义）。
 *
 * next() = 当前基数 + [0,500) 抖动（§9），随后基数翻倍封顶 30s；调用方在
 * 「上次连接存活 ≥ STABLE_CONN_MS」时 reset()——健康史归零，偶发瞬断不再
 * 从钉死的 30s 起步（旧实现成功后永不归零，掉线几次后每次白等 30s）。
 */

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30000;
/** 抖动上限（0–500ms，§9）。 */
const BACKOFF_JITTER_MS = 500;
/** 稳定连接判据：上次连接存活 ≥30s 视为「连上过」，退避归零重新计。 */
export const STABLE_CONN_MS = 30000;

export class Backoff {
  private cur: number = BACKOFF_BASE_MS;

  /** 下一次重连延迟 = 当前基数 + [0,500) 抖动；随后基数翻倍封顶。 */
  next(): number {
    const delay: number = this.cur + Math.floor(Math.random() * BACKOFF_JITTER_MS);
    this.cur = Math.min(this.cur * 2, BACKOFF_MAX_MS);
    return delay;
  }

  /** 归零（新会话开始 / 上次连接存活 ≥ STABLE_CONN_MS）。 */
  reset(): void {
    this.cur = BACKOFF_BASE_MS;
  }
}
