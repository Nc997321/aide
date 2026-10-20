// 子会话空闲休眠：一轮结束后没人再理它，到点就把 claude 进程悄悄关掉，省下几百 MB。
//
// 为什么只管子会话：普通会话靠「关 tab 即停」回收；子会话钻进父会话里看、自己不占 tab，
// 没有关闭这一步，不管就会一直挂着。休眠不丢东西——下一条消息（用户插话或父会话追加指令）
// 带着 resume id 进来，按转录原地续上，只多几秒冷启动。缓存也不会因此更冷：休眠时限比
// 提示词缓存的 5 分钟有效期长，到点时缓存本来就过期了。
//
// 关进程会断掉的东西都算「还有活」，到点了也不睡、过一个周期再看：一轮进行中、
// 在等批准或回答、后台命令在跑、异步子代理没回来、开着值守。

/** 子会话一轮结束后多久没动静就休眠。环境变量 AIDE_SUBSESSION_IDLE_SLEEP_MS 可覆盖（测试 / 调试用，0 = 不休眠）。 */
export const SUBSESSION_IDLE_SLEEP_MS = 10 * 60_000;

export function idleSleepMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AIDE_SUBSESSION_IDLE_SLEEP_MS;
  if (raw === undefined || raw === "") return SUBSESSION_IDLE_SLEEP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : SUBSESSION_IDLE_SLEEP_MS;
}

export interface IdleSleepDeps {
  /** 还有活就返回原因（不能睡），没有返回 null。 */
  busyReason(): string | null;
  /** 真正去睡（发事件 + 关进程）。 */
  sleep(): void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class IdleSleep {
  private timer: unknown = null;
  private readonly delay: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly deps: IdleSleepDeps) {
    this.delay = deps.delayMs ?? idleSleepMs();
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      // 不拖住进程退出
      (t as { unref?: () => void }).unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** 一轮结束：开始（重新）计时。 */
  arm(): void {
    this.cancel();
    if (this.delay <= 0) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.tryNow()) this.arm();
    }, this.delay);
  }

  /** 有新动作（新消息进来 / 会话停止）：不睡了。 */
  cancel(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** 现在没活就睡（Host 在父会话被关时也会直接叫这个）。返回是否睡了。 */
  tryNow(): boolean {
    if (this.deps.busyReason() !== null) return false;
    this.cancel();
    this.deps.sleep();
    return true;
  }

  get armed(): boolean {
    return this.timer !== null;
  }
}
