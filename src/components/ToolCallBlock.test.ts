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

  it("强制 card 的调用点保持卡片外观，没有结果摘要", () => {
    const mention = mountBlock({ block: block({ name: "Read" }), card: true, current: true });
    expect(mention.classes()).not.toContain("tool-item--line");
    expect(mention.find(".ti-peek").exists()).toBe(false);
  });
});

describe("ToolCallBlock — 变更类工具行", () => {
  const edit = (over: Partial<ToolCallBlockData> = {}) =>
    block({
      name: "Edit",
      input: { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" },
      result: "The file src/a.ts has been updated successfully.",
      ...over,
    });

  it("与查询工具同为无框工具行，头行带 +N −M", () => {
    const w = mountBlock({ block: edit() });
    expect(w.classes()).toContain("tool-item--line");
    expect(w.find(".ti-diff").text()).toBe("+2-1");
  });

  it("当前这一步预览 diff 片段而不是结果正文；被取代后只剩头行", () => {
    const current = mountBlock({ block: edit(), current: true });
    expect(current.find(".ti-peek-diff").exists()).toBe(true);
    expect(current.find(".ti-peek-lines").exists()).toBe(false);
    expect(current.text()).not.toContain("updated successfully");

    const superseded = mountBlock({ block: edit() });
    expect(superseded.find(".ti-peek").exists()).toBe(false);
  });

  it("预览超过 10 行时截断并注明剩余行数", () => {
    const content = Array.from({ length: 27 }, (_, i) => `line ${i + 1}`).join("\n");
    const w = mountBlock({
      block: block({ name: "Write", input: { file_path: "tools/x.py", content }, result: "ok" }),
      current: true,
    });
    expect(w.find(".ti-peek-more").text()).toBe("还有 17 行");
  });

  it("点预览 = 展开完整 diff，预览让位", async () => {
    const w = mountBlock({ block: edit(), current: true });
    await w.find(".ti-peek").trigger("click");
    expect(w.find(".ti-peek").exists()).toBe(false);
    expect(w.find(".ti-change").exists()).toBe(true);
  });

  it("出错的 Edit 退回结果正文预览（错误信息要看得见）", () => {
    const w = mountBlock({
      block: edit({ isError: true, result: "String to replace not found in file." }),
      current: true,
    });
    expect(w.find(".ti-peek-lines").text()).toBe("String to replace not found in file.");
  });
});
