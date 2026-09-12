// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import ThinkingBlock from "./ThinkingBlock.vue";
import { SETTLED_MAX_CHARS } from "@/composables/useStreamChunks";
import { CHUNK_CHARS } from "@aide/sdk/utils/streamSplit";

/** 与 ThinkingBlock 的 TAIL_MAX_CHUNKS 对齐（组件不导出，回填此处）。
 *  流式期保留窗口 = 落定前缀上限 + 尾巴上界。 */
const TAIL_MAX_CHUNKS = 400;
const WINDOW_CHARS = SETTLED_MAX_CHARS + TAIL_MAX_CHUNKS * CHUNK_CHARS;

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

/** body 的原文文本。走 textContent 而不是 wrapper.text()——后者会 trim。 */
function bodyText(w: ReturnType<typeof mount>): string {
  return (w.find(".thinking-body").element as HTMLElement).textContent ?? "";
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

  it("流式超窗：只渲染尾部窗口（… + 保留窗口），计数徽标仍是全文长度", () => {
    // 全文 12000 码元，末尾带特征串验证「钉底可见的恰是新内容」
    const text = "a".repeat(12000 - 6) + "TAIL_OK";
    const w = mount(ThinkingBlock, { props: { text, streaming: true } });
    const shown = bodyText(w);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.length).toBe(WINDOW_CHARS + 1);
    expect(shown.endsWith("TAIL_OK")).toBe(true);
    expect(w.find(".thinking-count").text()).toContain(`${text.length} 字`);
  });

  it("流式未超窗 / 非流式（含结束后）：渲染全文、无前缀", () => {
    const short = "短思考";
    const streaming = mount(ThinkingBlock, { props: { text: short, streaming: true } });
    expect(bodyText(streaming)).toBe(short);
    const long = "b".repeat(12000);
    const finalized = mount(ThinkingBlock, { props: { text: long, streaming: false } });
    expect(bodyText(finalized)).toBe(long);
  });

  it("流式期逐块 span；非流式期不切块（整段渲染）", () => {
    const streaming = mount(ThinkingBlock, { props: { text: "甲乙丙丁", streaming: true } });
    expect(streaming.findAll(".aide-wave-chunk").length).toBe(2);
    const finalized = mount(ThinkingBlock, { props: { text: "甲乙丙丁", streaming: false } });
    expect(finalized.findAll(".aide-wave-chunk").length).toBe(0);
  });

  // 容器是 white-space: pre-wrap——元素之间任何残留的模板空白文本节点都会变成
  // 可见空格。模板刻意写成紧凑形式，这条断言是它的守门人。
  it.each([
    ["流式", true],
    ["非流式", false],
  ])("%s：body 文本与原文逐字一致（无模板空白泄漏）", (_name, streaming) => {
    const text = "第一行\n第二行\n\n带 **标记**、`代码` 和 emoji 😀 的思考";
    const w = mount(ThinkingBlock, { props: { text, streaming } });
    expect(bodyText(w)).toBe(text);
  });

  it("增量追加 → 已有块节点不被重建（动画不重来）", async () => {
    const w = mount(ThinkingBlock, { props: { text: "甲乙丙丁", streaming: true } });
    const before = w.findAll(".aide-wave-chunk").map((s) => s.element);
    await w.setProps({ text: "甲乙丙丁戊己" });
    const after = w.findAll(".aide-wave-chunk").map((s) => s.element);
    expect(after.length).toBe(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
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