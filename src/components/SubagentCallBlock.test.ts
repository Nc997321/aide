// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { SubagentBlock, SubagentEntry } from "@/types/chat";
import SubagentCallBlock from "./SubagentCallBlock.vue";

const GL = { stubs: { ToolCallBlock: true }, directives: { tooltip: {} } };

let seq = 0;
const toolStep = (): SubagentEntry => ({ type: "tool", toolUseId: `t${seq++}`, toolName: "Read", input: {} });
const steps = (n: number): SubagentEntry[] => Array.from({ length: n }, toolStep);

const block = (over: Partial<SubagentBlock> = {}): SubagentBlock => ({
  type: "subagent",
  id: "sa1",
  agentName: "general-purpose",
  description: "调研 XX",
  entries: [],
  isPending: true,
  ...over,
});

function mountBlock(over: Partial<SubagentBlock> = {}) {
  return mount(SubagentCallBlock, { props: { block: block(over) }, global: GL });
}

describe("SubagentCallBlock — 一行摘要（折叠态即全部）", () => {
  it("运行中：胶囊写「● N 步」，并画 N 条步数墨线", () => {
    const wrapper = mountBlock({ entries: steps(3) });
    expect(wrapper.find(".sa-chip").text()).toBe("● 3 步");
    expect(wrapper.find(".sa-chip").classes()).toContain("sa-chip--run");
    expect(wrapper.findAll(".sa-ticks i")).toHaveLength(3);
  });

  it("刚派发还没迈步：退化成「● 运行中」，不画墨线（0 步只是噪音）", () => {
    const wrapper = mountBlock({ entries: [] });
    expect(wrapper.find(".sa-chip").text()).toBe("● 运行中");
    expect(wrapper.find(".sa-ticks").exists()).toBe(false);
  });

  it("已完成：✓ N 步，不画墨线（步数是静态事实，数字足够）", () => {
    const wrapper = mountBlock({ entries: steps(5), isPending: false, result: "结论" });
    expect(wrapper.find(".sa-chip").text()).toBe("✓ 5 步");
    expect(wrapper.find(".sa-chip").classes()).toContain("sa-chip--done");
    expect(wrapper.find(".sa-ticks").exists()).toBe(false);
  });

  it("出错：✗ N 步 + 左条转危险色（折叠态也要看得出没跑成）", () => {
    const wrapper = mountBlock({ entries: steps(2), isPending: false, isError: true });
    expect(wrapper.find(".sa-chip").text()).toBe("✗ 2 步");
    expect(wrapper.find(".sa-chip").classes()).toContain("sa-chip--err");
    expect(wrapper.classes()).toContain("sa--err");
  });

  it("步数墨线超上限截断：长跑子代理不把一行铺满", () => {
    const wrapper = mountBlock({ entries: steps(30) });
    expect(wrapper.find(".sa-chip").text()).toBe("● 30 步");
    expect(wrapper.findAll(".sa-ticks i")).toHaveLength(12);
  });

  it("折叠态不渲染时间线；点开后原位展开（派发指令 + 工具步）", async () => {
    const wrapper = mountBlock({
      prompt: "x".repeat(2932),
      entries: [toolStep(), { type: "text", text: "Alright." }],
    });
    expect(wrapper.find(".sa-timeline").exists()).toBe(false);
    await wrapper.find(".sa-head").trigger("click");
    expect(wrapper.find(".sa-timeline").exists()).toBe(true);
    expect(wrapper.find(".sa-prompt-label").text()).toBe("派发指令 · 2932 字");
    // 时间线与 dock 阅读区共用同一实现（subagent/SubagentTimeline.vue）
    expect(wrapper.findAll(".sa-timeline > *")).toHaveLength(3); // 派发指令 + 工具步 + 文本
  });
});
