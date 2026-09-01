// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ThinkingBlock from "./ThinkingBlock.vue";

/** 与 ThinkingBlock 的 STREAM_TAIL_CHARS 对齐（组件不导出，回填此处窗口值）。 */
const STREAM_TAIL_CHARS = 8000;

/** rAF 桩：cb 入队不执行（flush 才跑），cancel 计数——测「每帧合并/取消」。 */
function rafStub() {
  const queue: Array<() => void> = [];
  let cancelCount = 0;
  return {
    raf: (cb: () => void) => {
      queue.push(cb);
      return queue.length;
    },
    cancel: vi.fn(),
    flush: () => {
      while (queue.length > 0) queue.shift()!();
    },
    pending: () => queue.length,
  };
}

describe("ThinkingBlock", () => {
  let stub: ReturnType<typeof rafStub>;
  beforeEach(() => {
    stub = rafStub();
    vi.stubGlobal("requestAnimationFrame", stub.raf as unknown as typeof requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", stub.cancel);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("流式超窗：只渲染尾部窗口（… + 末 8000 字符），计数徽标仍是全文长度", () => {
    // 全文 12000 码元，末尾带特征串验证「钉底可见的恰是新内容」
    const text = "a".repeat(12000 - 6) + "TAIL_OK";
    const w = mount(ThinkingBlock, { props: { text, streaming: true } });
    const shown = w.find(".thinking-body").text();
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.length).toBe(STREAM_TAIL_CHARS + 1);
    expect(shown.endsWith("TAIL_OK")).toBe(true);
    expect(w.find(".thinking-count").text()).toContain(`${text.length} 字`);
  });

  it("流式未超窗 / 非流式（含结束后）：渲染全文、无前缀", () => {
    const short = "短思考";
    const streaming = mount(ThinkingBlock, { props: { text: short, streaming: true } });
    expect(streaming.find(".thinking-body").text()).toBe(short);
    const long = "b".repeat(12000);
    const finalized = mount(ThinkingBlock, { props: { text: long, streaming: false } });
    expect(finalized.find(".thinking-body").text()).toBe(long);
  });

  it("同帧多条 delta 合并钉底：三条 delta 只有一个在途帧", async () => {
    const w = mount(ThinkingBlock, { props: { text: "d1", streaming: true } });
    await w.setProps({ text: "d2" });
    await w.setProps({ text: "d3" });
    await w.setProps({ text: "d4" });
    expect(stub.pending()).toBe(1); // 合并——不是 3
    stub.flush(); // 帧执行：钉底读数（无真实几何，scrollTop 写入为 no-op）
    expect(stub.pending()).toBe(0);
    await w.setProps({ text: "d5" });
    expect(stub.pending()).toBe(1); // 消费后可再排程（每帧互斥，不是每会话锁死）
    stub.flush();
  });

  it("卸载时取消在途钉底帧（不泄漏 rAF）", async () => {
    const w = mount(ThinkingBlock, { props: { text: "d1", streaming: true } });
    await w.setProps({ text: "d2" });
    expect(stub.pending()).toBe(1);
    w.unmount();
    expect(stub.cancel).toHaveBeenCalled();
  });

  it("truncated 时计数徽标显示原始字节数", () => {
    const w = mount(ThinkingBlock, {
      props: { text: "abc", truncated: { originalBytes: 2048 }, streaming: false },
    });
    expect(w.find(".thinking-count").text()).toContain("1024 字");
  });
});