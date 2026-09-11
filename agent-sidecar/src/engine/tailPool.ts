// 通用输出 tail 池：SessionWorker 的两组 per-instance 轮询（子代理 .output 回放 /
// 后台 shell 任务输出）形状完全一致——Map<id, tail> + 600ms unref 定时器 +
// start 幂等 + 空池清定时器。历史是 worker 里两份手写副本，收编成一个泛型池
// （纯移动去重，行为逐分支保持）。
//
// 两种池的唯一差异在「stop 单个 tail 时怎么收尾」，由构造器的 removeTail 显式注入：
//   - 子代理 .output：t.stop() 即可
//   - 后台任务：void t.finalFlush().catch(...)——先冲掉文件尾巴再摘（不立即 stop，
//     finalFlush 内部完成后自置 stopped）
import type { ChatEvent } from "./types.js";

/** 池成员的最小契约：异步增量读 + 终止标记。 */
export interface PoolableTail {
  tick(): Promise<void>;
  stop(): void;
}

const POOL_INTERVAL_MS = 600; // 肉眼「实时」又不至于 IO 洪峰（每 tail 一个 stat+read）

export class TailPool<T extends PoolableTail> {
  private tails = new Map<string, T>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly factory: (id: string, outputFile: string, emit: (e: ChatEvent) => void) => T,
    /** stop(id) 摘除时的收尾（差异点注入）：缺省 = 直接 t.stop()。 */
    private readonly removeTail?: (t: T) => void,
  ) {}

  /** 启动一个 tail，加入轮询。幂等：同 id 重复启动忽略（ack 重复到达不重启）。 */
  start(id: string, outputFile: string, emit: (e: ChatEvent) => void): void {
    if (this.tails.has(id)) return;
    this.tails.set(id, this.factory(id, outputFile, emit));
    this.ensureTimer();
  }

  /** 摘除单个 tail：收尾走 removeTail（如 finalFlush）；删除先于收尾完成——
   *  tail 对象仍被收尾 promise 持有，emit 照常生效。空池清定时器。 */
  stop(id: string): void {
    const t = this.tails.get(id);
    if (t) {
      if (this.removeTail) this.removeTail(t);
      else t.stop();
      this.tails.delete(id);
    }
    if (this.tails.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 全部终止并清空（会话停止路径）：直接 stop，不等收尾。 */
  stopAll(): void {
    for (const t of this.tails.values()) t.stop();
    this.tails.clear();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const t of this.tails.values()) {
        // fire-and-forget：异步读不阻塞事件循环；单条 tail 出错（文件被删/读失败）
        // 不影响其它 tail，下次轮询自动重试。
        void t.tick().catch(() => { /* 单条 tail 出错不影响其它 */ });
      }
    }, POOL_INTERVAL_MS);
    this.timer.unref(); // 不阻止进程自然退出
  }
}
