import type { ChatEvent } from "./types.js";

/**
 * stdout 事件出口的文本增量合并层。
 *
 * SDK 的 includePartialMessages 让 text_delta / subagent_*_delta 逐字到达——
 * 一轮回复动辄几百上千个事件，每个事件都要走一遍
 * stdout 行 → Rust 解析 → app.emit → WebView ExecuteScript → Vue 重渲染，
 * 前端每个增量还会对整条消息全文重跑 Markdown 解析 + 强制布局（会话越长越贵），
 * 事件到达速度一旦超过渲染速度，UI 就雪崩式卡死。
 *
 * 这里把纯文本增量在 FLUSH_INTERVAL_MS 窗口内按 key（类型 + 子代理 id）拼接后
 * 再输出：几百个事件压成每秒 ~25 个，语义不变（拼接顺序 = 到达顺序）。
 * 非增量事件（tool_use_start / message_stop / 心跳……）不能与增量乱序——
 * 到达时先冲刷缓冲再原样透传，保证事件间相对顺序与合并前完全一致。
 */

type EmitFn = (event: ChatEvent) => void;

/** 可合并的纯文本增量事件：同 key 的 delta 拼接后语义不变。 */
type DeltaEvent = Extract<ChatEvent, { delta: string }>;

const COALESCABLE_TYPES: ReadonlySet<string> = new Set([
  "text_delta",
  "subagent_text_delta",
  "subagent_thinking_delta",
  "bg_task_output",
]);

const FLUSH_INTERVAL_MS = 40;

function isDeltaEvent(event: ChatEvent): event is DeltaEvent {
  return COALESCABLE_TYPES.has(event.type);
}

/** 合并 key：类型 + 目标 id（主线程 text_delta 无 id，子代理/后台任务增量按各自 id 区分）。 */
function keyOf(event: DeltaEvent): string {
  const id = "id" in event ? event.id : "";
  return `${event.type}:${id}`;
}

export class DeltaCoalescer {
  /** 窗口内待冲刷的增量组，保持到达顺序；同 key 只会出现在相邻位置时合并。 */
  private pending: DeltaEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: EmitFn,
    private readonly intervalMs: number = FLUSH_INTERVAL_MS,
  ) {}

  push(event: ChatEvent): void {
    if (!isDeltaEvent(event)) {
      // 非增量事件必须保持与增量的相对顺序：先冲刷缓冲，再透传
      this.flush();
      this.sink(event);
      return;
    }

    const last = this.pending[this.pending.length - 1];
    if (last && keyOf(last) === keyOf(event)) {
      last.delta += event.delta;
    } else {
      // 浅拷贝：不改动上游传入的事件对象
      this.pending.push({ ...event });
    }

    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      // 不阻止进程自然退出（对齐心跳定时器的处理）
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** 按到达顺序输出缓冲中的所有增量组并清空窗口定时器。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const groups = this.pending;
    this.pending = [];
    for (const g of groups) this.sink(g);
  }
}
