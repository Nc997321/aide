// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { ContentBlock } from "@/types/chat";
import { segmentBlocks, type Segment } from "@/utils/blockSegments";
import ProcessGroup from "./ProcessGroup.vue";

/** 走真实分段链路造 process 段，不断言手搓夹具。 */
function processSegmentsOf(blocks: ContentBlock[]): Segment[] {
  const proc = segmentBlocks(blocks, { finalized: true }).find((s) => s.kind === "process");
  if (!proc || proc.kind !== "process") throw new Error("fixture 未产生 process 段");
  return proc.segments;
}

let nextId = 0;
const tool = (name: string, over: Record<string, unknown> = {}): ContentBlock => ({
  type: "tool_call", id: `t${nextId++}`, name, input: {}, isPending: false, ...over,
});
const thinking = (t: string): ContentBlock => ({ type: "thinking", text: t });

const STUBS = { ToolCallGroup: true, ThinkingBlock: true, SubagentCallBlock: true };

describe("ProcessGroup — 过程胶囊", () => {
  it("默认收起：只渲染摘要头（思考段数 · 工具次数），不渲染内容体", () => {
    const segments = processSegmentsOf([tool("Read"), thinking("t"), tool("Grep")]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS } });
    expect(wrapper.find(".pg-summary").text()).toContain("1 段思考");
    expect(wrapper.find(".pg-summary").text()).toContain("2 次工具调用");
    expect(wrapper.find(".pg-body").exists()).toBe(false);
  });

  it("点击摘要头展开，按原序渲染段内全部过程项", async () => {
    const segments = processSegmentsOf([tool("Read"), thinking("t"), tool("Grep")]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS } });
    await wrapper.find(".pg-head").trigger("click");
    expect(wrapper.find(".pg-body").exists()).toBe(true);
    expect(wrapper.findAll(".pg-body > *")).toHaveLength(3);
  });

  it("段内有子代理时摘要带子代理数", () => {
    const subagent: ContentBlock = {
      type: "subagent", id: "s1", agentName: "Explore", description: "", entries: [], isPending: false,
    };
    const segments = processSegmentsOf([subagent, thinking("t")]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS } });
    expect(wrapper.find(".pg-summary").text()).toContain("1 个子代理");
  });
});
