import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeltaCoalescer } from "./deltaCoalescer.js";
import type { ChatEvent } from "./types.js";

function collect(): { events: ChatEvent[]; sink: (e: ChatEvent) => void } {
  const events: ChatEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

describe("DeltaCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // 核心收益：窗口内的逐字增量必须压成一条，否则前端每个字符都要全量重渲染。
  it("merges consecutive text_delta within the flush window", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "text_delta", delta: "你" });
    c.push({ type: "text_delta", delta: "好" });
    c.push({ type: "text_delta", delta: "！" });
    expect(events).toEqual([]); // 窗口未到，不输出

    vi.advanceTimersByTime(40);
    expect(events).toEqual([{ type: "text_delta", delta: "你好！" }]);
  });

  // 主线程 thinking 逐字增量（无 id）同样按 key 合并——流式思考的事件洪峰也压成一条。
  it("merges consecutive thinking_delta (main thread, no id) within the flush window", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "thinking_delta", delta: "我" });
    c.push({ type: "thinking_delta", delta: "在想" });
    c.push({ type: "thinking_delta", delta: "…" });

    vi.advanceTimersByTime(40);
    expect(events).toEqual([{ type: "thinking_delta", delta: "我在想…" }]);
  });

  // 非增量事件到达时先冲刷缓冲——tool_use_start 不能跑到它之前的文本前面去。
  it("flushes pending deltas before passing through a non-delta event", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "text_delta", delta: "先说一句" });
    c.push({ type: "tool_use_start", id: "t1", name: "Bash", input: {} });

    expect(events).toEqual([
      { type: "text_delta", delta: "先说一句" },
      { type: "tool_use_start", id: "t1", name: "Bash", input: {} },
    ]);
  });

  it("flushes buffered text before emitting a context compaction status", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "text_delta", delta: "压缩前的最后一句" });
    c.push({ type: "context_compaction", stage: "compacting" });

    expect(events).toEqual([
      { type: "text_delta", delta: "压缩前的最后一句" },
      { type: "context_compaction", stage: "compacting" },
    ]);
  });

  // 不同 key（主线程文本 vs 子代理文本）不互并，但输出顺序 = 到达顺序。
  it("keeps distinct keys separate while preserving arrival order", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "text_delta", delta: "a" });
    c.push({ type: "subagent_text_delta", id: "s1", delta: "x" });
    c.push({ type: "subagent_text_delta", id: "s1", delta: "y" });
    c.push({ type: "text_delta", delta: "b" });

    vi.advanceTimersByTime(40);
    expect(events).toEqual([
      { type: "text_delta", delta: "a" },
      { type: "subagent_text_delta", id: "s1", delta: "xy" },
      { type: "text_delta", delta: "b" },
    ]);
  });

  // 同类型不同子代理 id 是两条独立通道，绝不能把两个子代理的文字拼到一起。
  it("does not merge subagent deltas with different ids", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "subagent_text_delta", id: "s1", delta: "x" });
    c.push({ type: "subagent_text_delta", id: "s2", delta: "y" });

    vi.advanceTimersByTime(40);
    expect(events).toEqual([
      { type: "subagent_text_delta", id: "s1", delta: "x" },
      { type: "subagent_text_delta", id: "s2", delta: "y" },
    ]);
  });

  // 后台任务输出是逐段增量：同任务合并、不同任务（或与子代理增量）不互并。
  it("merges bg_task_output deltas per task id", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "bg_task_output", id: "t1", delta: "line1\n" });
    c.push({ type: "bg_task_output", id: "t1", delta: "line2\n" });
    c.push({ type: "bg_task_output", id: "t2", delta: "other\n" });
    c.push({ type: "bg_task_output", id: "t1", delta: "line3\n" });

    vi.advanceTimersByTime(40);
    expect(events).toEqual([
      { type: "bg_task_output", id: "t1", delta: "line1\nline2\n" },
      { type: "bg_task_output", id: "t2", delta: "other\n" },
      { type: "bg_task_output", id: "t1", delta: "line3\n" },
    ]);
  });

  // text 与 thinking 是不同渲染通道（前端样式不同），类型切换必须另起一组。
  it("does not merge text and thinking deltas of the same subagent", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "subagent_thinking_delta", id: "s1", delta: "想" });
    c.push({ type: "subagent_text_delta", id: "s1", delta: "说" });

    vi.advanceTimersByTime(40);
    expect(events).toEqual([
      { type: "subagent_thinking_delta", id: "s1", delta: "想" },
      { type: "subagent_text_delta", id: "s1", delta: "说" },
    ]);
  });

  // 无缓冲时非增量事件零延迟透传——心跳/权限请求不能被合并层拖慢。
  it("passes through non-delta events immediately when nothing is pending", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "heartbeat" });
    expect(events).toEqual([{ type: "heartbeat" }]);
  });

  // 上游可能复用事件对象；合并层必须拷贝，不能原地改别人的 delta。
  it("does not mutate the caller's event object", () => {
    const { sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    const first: ChatEvent = { type: "text_delta", delta: "a" };
    c.push(first);
    c.push({ type: "text_delta", delta: "b" });
    expect(first.delta).toBe("a");
  });

  // 窗口冲刷后再来的增量要开新窗口，不能沾上一窗的状态。
  it("starts a fresh window after a flush", () => {
    const { events, sink } = collect();
    const c = new DeltaCoalescer(sink, 40);

    c.push({ type: "text_delta", delta: "一" });
    vi.advanceTimersByTime(40);
    c.push({ type: "text_delta", delta: "二" });
    vi.advanceTimersByTime(40);

    expect(events).toEqual([
      { type: "text_delta", delta: "一" },
      { type: "text_delta", delta: "二" },
    ]);
  });
});
