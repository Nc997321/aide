// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick, reactive } from "vue";
import type { ContentBlock, ToolCallBlock as ToolData } from "@/types/chat";
import { segmentBlocks, type ProcessSegment } from "@/utils/blockSegments";
import ProcessGroup from "./ProcessGroup.vue";
import StaticDiff from "./fileviewer/StaticDiff.vue";
import { locateEditStartLine } from "@/utils/changeCard";

vi.mock("../composables/useSettings", () => ({
  useSettings: () => ({ settings: { terminalFontFamily: "", fontSize: 13 } }),
}));
vi.mock("../utils/changeCard", async importOriginal => ({
  ...await importOriginal<typeof import("../utils/changeCard")>(),
  locateEditStartLine: vi.fn().mockResolvedValue(1),
}));

const tool = (over: Partial<ToolData> = {}): ToolData => ({
  type: "tool_call", id: "read", name: "Read", input: { file_path: "src/a.ts" },
  result: "const a = 1;", isPending: false, ...over,
});
const edit = () => tool({
  id: "edit", name: "Edit", isPending: true, result: undefined,
  input: { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
});
function group(blocks: ContentBlock[], options = { finalized: false, showThinking: true }): ProcessSegment {
  const segment = segmentBlocks(blocks, options)[0];
  if (!segment || segment.kind !== "process") throw new Error("缺少过程组");
  return segment;
}
const wrappers: ReturnType<typeof mount>[] = [];
function mountGroup(segment: ProcessSegment, showThinking = true) {
  const wrapper = mount(ProcessGroup, {
    props: { segment, finalized: false, showThinking },
    global: {
      directives: { tooltip: {} },
      stubs: { BashOutputBlock: true, StaticDiff: true, SubagentTimeline: true },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); });

describe("ProcessGroup", () => {
  it("不同过程收起只有当前指令一行，点击同时打开当前详情与历史", async () => {
    const read = tool();
    const bash = tool({ id: "bash", name: "Bash", input: { command: "pnpm test" }, result: "passed" });
    const wrapper = mountGroup(group([read, bash]));
    expect(wrapper.findAll(".ti-row")).toHaveLength(1);
    expect(wrapper.find(".ti-row").text()).toContain("pnpm test");
    expect(wrapper.find(".process-count").text()).toBe("1 项历史");
    expect(wrapper.find(".ti-peek").exists()).toBe(false);
    expect(wrapper.find(".process-history").exists()).toBe(false);
    await wrapper.find(".ti-row").trigger("click");
    expect(wrapper.find("bash-output-block-stub").exists()).toBe(true);
    expect(wrapper.find(".process-history .ti-row").text()).toContain("a.ts");
    await wrapper.find(".ti-row").trigger("click");
    expect(wrapper.find(".process-history").exists()).toBe(false);
  });

  it("写入预览运行中和完成后都保留，正文/思考不撤掉，下一指令才收进历史", async () => {
    const write = edit();
    const wrapper = mountGroup(group([tool(), write]));
    expect(wrapper.find(".ti-peek-diff").exists()).toBe(true);
    expect(wrapper.findAll(".ti-row")).toHaveLength(1);
    const completed = { ...write, isPending: false, result: "updated" };
    const body: ContentBlock = { type: "text", text: "这里是解释" };
    await wrapper.setProps({ segment: group([tool(), completed, { type: "thinking", text: "再想想" }, body]) });
    expect(wrapper.find(".ti-peek-diff").exists()).toBe(true);
    expect(wrapper.find(".ti-row").text()).toContain("修改了");
    await wrapper.find(".ti-row").trigger("click");
    expect(wrapper.find(".ti-change").exists()).toBe(true);
    expect(wrapper.find(".process-history").exists()).toBe(true);
    await wrapper.setProps({ segment: group([tool(), completed, tool({ id: "next", isPending: true })]) });
    expect(wrapper.find(".ti-peek").exists()).toBe(false);
    expect(wrapper.findAll(".ti-row")).toHaveLength(1);
    expect(wrapper.find(".process-history").exists()).toBe(false);
    await wrapper.find(".ti-row").trigger("click");
    expect(wrapper.findAll(".process-history .ti-row")).toHaveLength(2);
  });

  it("回答结束收起已打开的组和写入预览，仍可手动查看", async () => {
    const write = { ...edit(), isPending: false, result: "updated" };
    const wrapper = mountGroup(group([tool(), write]));
    await wrapper.find(".ti-row").trigger("click");
    expect(wrapper.find(".ti-change").exists()).toBe(true);
    await wrapper.setProps({ segment: group([tool(), write], { finalized: true, showThinking: true }), finalized: true });
    expect(wrapper.find(".ti-row").attributes("aria-expanded")).toBe("false");
    expect(wrapper.find(".ti-peek").exists()).toBe(false);
    expect(wrapper.find(".process-history").exists()).toBe(false);
    await wrapper.find(".ti-row").trigger("click");
    expect(wrapper.find(".ti-change").exists()).toBe(true);
  });

  it("失败的历史在收起时仍有提示，单条过程不显示历史计数", () => {
    const failed = tool({ isError: true, result: "failed" });
    const history = mountGroup(group([failed, tool({ id: "next" })]));
    expect(history.find(".process-errors").text()).toBe("1 项未成功");
    const single = mountGroup(group([tool()]));
    expect(single.find(".process-count").exists()).toBe(false);
    expect(single.find(".process-errors").exists()).toBe(false);
  });

  it("子代理作为入口，点击直接展示时间线与工具历史", async () => {
    const wrapper = mountGroup(group([tool(), {
      type: "subagent", id: "agent", agentName: "Explore", description: "查引用", entries: [], isPending: true,
    }]));
    expect(wrapper.find(".sa-head").text()).toContain("查引用");
    expect(wrapper.find(".ti-row").exists()).toBe(false);
    await wrapper.find(".sa-head").trigger("click");
    expect(wrapper.find("subagent-timeline-stub").exists()).toBe(true);
    expect(wrapper.find(".process-history .ti-row").exists()).toBe(true);
  });

  it("思考入口跟随受控开合，历史思考也可查看", async () => {
    const wrapper = mountGroup(group([
      { type: "thinking", text: "先前思考" }, { type: "thinking", text: "当前思考" },
    ]));
    const details = wrapper.find("details");
    expect(details.attributes("open")).toBeUndefined();
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger("toggle");
    await nextTick();
    expect(wrapper.find(".process-history .thinking-head").text()).toContain("思考");
    expect(wrapper.find(".thinking-body").text()).toBe("当前思考");
    (details.element as HTMLDetailsElement).open = false;
    await details.trigger("toggle");
    expect(wrapper.find(".process-history").exists()).toBe(false);
  });

  it("连续修改不同文件时重建当前步骤，不沿用上次的 diff 行号缓存", async () => {
    vi.mocked(locateEditStartLine).mockResolvedValueOnce(12).mockResolvedValueOnce(34);
    const first = edit();
    const wrapper = mountGroup(group([first]));
    await flushPromises();
    expect(wrapper.findComponent(StaticDiff).props("firstLineNumber")).toBe(12);
    const second = { ...edit(), id: "edit-second", input: { file_path: "src/b.ts", old_string: "const b = 1;", new_string: "const b = 2;" } };
    await wrapper.setProps({ segment: group([first, second]) });
    await flushPromises();
    expect(wrapper.findComponent(StaticDiff).props("filePath")).toBe("src/b.ts");
    expect(wrapper.findComponent(StaticDiff).props("firstLineNumber")).toBe(34);
  });

  it("响应式结果回填更新当前标题，不关闭用户打开的详情", async () => {
    const write = reactive(edit());
    const wrapper = mountGroup(group([tool(), write]));
    await wrapper.find(".ti-row").trigger("click");
    write.isPending = false;
    write.result = "updated";
    await nextTick();
    expect(wrapper.find(".ti-row").text()).toContain("修改了");
    expect(wrapper.find(".ti-change").exists()).toBe(true);
    expect(wrapper.find(".process-history").exists()).toBe(true);
  });

  it("纯思考结束时关闭原生 details；重新打开仍可读历史", async () => {
    const blocks: ContentBlock[] = [{ type: "thinking", text: "先前" }, { type: "thinking", text: "当前" }];
    const wrapper = mountGroup(group(blocks));
    const details = wrapper.find("details");
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger("toggle");
    expect(wrapper.find(".process-history").exists()).toBe(true);
    await wrapper.setProps({ segment: group(blocks, { finalized: true, showThinking: true }), finalized: true });
    await details.trigger("toggle");
    expect(details.element.open).toBe(false);
    expect(wrapper.find(".process-history").exists()).toBe(false);
    details.element.open = true;
    await details.trigger("toggle");
    expect(wrapper.find(".process-history").exists()).toBe(true);
  });

  it("隐藏思考开关不泄露思考内容；命令后隐藏思考不计入历史", () => {
    const hidden = mountGroup(group([{ type: "thinking", text: "不能显示" }], { finalized: false, showThinking: false }), false);
    expect(hidden.text()).toContain("正在思考");
    expect(hidden.find(".thinking-body").exists()).toBe(false);
    expect(hidden.text()).not.toContain("不能显示");
    const command = mountGroup(group([tool(), { type: "thinking", text: "隐藏" }], { finalized: false, showThinking: false }), false);
    expect(command.find(".ti-row").exists()).toBe(true);
    expect(command.find(".process-count").exists()).toBe(false);
  });
});
