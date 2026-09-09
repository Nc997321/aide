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

const STUBS = { ToolCallBlock: true, ThinkingBlock: true, SubagentCallBlock: true };

describe("ProcessGroup — 过程胶囊", () => {
  it("默认收起：只渲染摘要头（思考段数 · 工具种类分布），不渲染内容体", () => {
    const segments = processSegmentsOf([tool("Read"), thinking("t"), tool("Grep")]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS, directives: { tooltip: {} } } });
    const text = wrapper.find(".pg-summary").text();
    expect(text).toContain("1 段思考");
    expect(text).toContain("Read ×1");
    expect(text).toContain("Grep ×1");
    expect(text).not.toContain("次工具调用");
    expect(wrapper.find(".pg-body").exists()).toBe(false);
  });

  it("点击摘要头展开，按原序渲染段内全部过程项", async () => {
    const segments = processSegmentsOf([tool("Read"), thinking("t"), tool("Grep")]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS, directives: { tooltip: {} } } });
    await wrapper.find(".pg-head").trigger("click");
    expect(wrapper.find(".pg-body").exists()).toBe(true);
    expect(wrapper.findAll(".pg-body > *")).toHaveLength(3);
  });

  it("工具组段平铺成逐条工具卡，不套「N 次工具调用」折叠壳", async () => {
    // Read+Grep 连续 → 同一 tool_group（2 条）；再跟一个思考段凑足 process
    const segments = processSegmentsOf([tool("Read"), tool("Grep"), thinking("t")]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS, directives: { tooltip: {} } } });
    await wrapper.find(".pg-head").trigger("click");
    // 平铺 = 2 条工具卡 + 1 个思考块；若仍套组内折叠壳则只有 2 个（1 组 + 1 思考）
    expect(wrapper.findAll(".pg-body > *")).toHaveLength(3);
  });

  it("摘要列工具种类分布，不重复写总数", () => {
    const segments = processSegmentsOf([tool("Read"), tool("Grep"), tool("Read"), thinking("t")]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS, directives: { tooltip: {} } } });
    const text = wrapper.find(".pg-summary").text();
    expect(text).toContain("Read ×2"); // 按次数降序，Read 排在 Grep 前
    expect(text).toContain("Grep ×1");
    expect(text).not.toContain("次工具调用"); // 总数由分布相加得出，不重复计数
  });

  it("种类超 3 时其余合并仍带次数，总数依旧可加总", () => {
    const segments = processSegmentsOf([
      tool("Read"), tool("Read"), tool("Grep"), tool("Glob"), tool("Bash"), tool("WebFetch"),
      thinking("t"),
    ]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS, directives: { tooltip: {} } } });
    const text = wrapper.find(".pg-summary").text();
    expect(text).toContain("Read ×2");
    expect(text).toContain("其余 2 项 ×2"); // Bash + WebFetch；2+1+1+2 = 6 条，与实际相符
  });

  it("段内有子代理时摘要带子代理数", () => {
    const subagent: ContentBlock = {
      type: "subagent", id: "s1", agentName: "Explore", description: "", entries: [], isPending: false,
    };
    const segments = processSegmentsOf([subagent, thinking("t")]);
    const wrapper = mount(ProcessGroup, { props: { segments }, global: { stubs: STUBS, directives: { tooltip: {} } } });
    expect(wrapper.find(".pg-summary").text()).toContain("1 个子代理");
  });
});
