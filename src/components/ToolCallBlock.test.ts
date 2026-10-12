// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import type { ToolCallBlock as ToolCallBlockData } from "@/types/chat";

vi.mock("../composables/useSettings", () => ({
  useSettings: () => ({ settings: { terminalFontFamily: "", fontSize: 13 } }),
}));

import ToolCallBlock from "./ToolCallBlock.vue";

const block = (over: Partial<ToolCallBlockData> = {}): ToolCallBlockData => ({
  type: "tool_call", id: "t1", name: "Grep", input: { pattern: "foo", path: "src/" },
  result: "Found 4 files\na.ts\nb.ts\nc.ts\nd.ts", isPending: false, ...over,
});

const mountBlock = (props: Record<string, unknown>) =>
  mount(ToolCallBlock, {
    props: props as never,
    global: { directives: { tooltip: {} }, stubs: { BashOutputBlock: true, StaticDiff: true } },
  });

describe("ToolCallBlock — 工具行", () => {
  it("查询类工具是无框的工具行：人话摘要，头行不带状态文字", () => {
    const w = mountBlock({ block: block() });
    expect(w.classes()).toContain("tool-item--line");
    expect(w.find(".ti-summary").text()).toBe('"foo" in src/');
    expect(w.find(".ti-row").text()).toBe('Grep"foo" in src/');
  });

  it("只有「当前这一步」带结果预览；被取代后只剩头行", () => {
    const current = mountBlock({ block: block(), current: true });
    expect(current.find(".ti-peek-lines").text()).toBe("Found 4 files\na.ts\nb.ts");
    expect(current.find(".ti-peek-more").text()).toBe("还有 2 行");

    const superseded = mountBlock({ block: block() });
    expect(superseded.find(".ti-peek").exists()).toBe(false);
  });

  it("点预览 = 展开全文，预览让位", async () => {
    const w = mountBlock({ block: block(), current: true });
    await w.find(".ti-peek").trigger("click");
    expect(w.find(".ti-peek").exists()).toBe(false);
    expect(w.find(".ti-result").text()).toContain("d.ts");
  });

  it("还没出结果 / 无匹配的当前项：只有圆点，不出「运行中」「无匹配」之类的文字", () => {
    const running = mountBlock({ block: block({ result: undefined, isPending: true }), current: true });
    expect(running.find(".ti-dot--run").exists()).toBe(true);
    expect(running.find(".ti-peek").exists()).toBe(false);
    expect(running.text()).toBe('Grep"foo" in src/');

    const none = mountBlock({ block: block({ result: "No matches found" }), current: true });
    expect(none.find(".ti-peek").exists()).toBe(false);
    expect(none.text()).toBe('Grep"foo" in src/');
  });

  it("变更卡与强制 card 的调用点保持卡片外观，没有结果摘要", () => {
    const edit = mountBlock({ block: block({ name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } }) });
    expect(edit.classes()).not.toContain("tool-item--line");
    const mention = mountBlock({ block: block({ name: "Read" }), card: true, current: true });
    expect(mention.classes()).not.toContain("tool-item--line");
    expect(mention.find(".ti-peek").exists()).toBe(false);
  });
});
