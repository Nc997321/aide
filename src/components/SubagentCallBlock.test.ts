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

describe("SubagentCallBlock — 一句旁白", () => {
  it("运行中：「助手正在「…」…（第 N 步）」带流光", () => {
    const wrapper = mountBlock({ entries: steps(3) });
    expect(wrapper.find(".sa-text").text()).toBe("助手正在「调研 XX」…（第 3 步）");
    expect(wrapper.find(".sa-text").classes()).toContain("aide-narr-live");
  });

  it("刚派发还没迈步：不写步数", () => {
    const wrapper = mountBlock({ entries: [] });
    expect(wrapper.find(".sa-text").text()).toBe("助手正在「调研 XX」…");
  });

  it("已完成：「派了一个助手去「…」，用了 N 步」", () => {
    const wrapper = mountBlock({ entries: steps(5), isPending: false, result: "结论" });
    expect(wrapper.find(".sa-text").text()).toBe("派了一个助手去「调研 XX」，用了 5 步");
    expect(wrapper.find(".sa-text").classes()).not.toContain("aide-narr-live");
  });

  it("出错：说没成功，并标危险色", () => {
    const wrapper = mountBlock({ entries: steps(2), isPending: false, isError: true });
    expect(wrapper.find(".sa-text").text()).toBe("派了一个助手去「调研 XX」，2 步后没成功");
    expect(wrapper.classes()).toContain("sa--err");
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
