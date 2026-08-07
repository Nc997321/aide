// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ThinkingBlock from "./ThinkingBlock.vue";

describe("ThinkingBlock — 流式期滚轮穿透（滚动陷阱修复）", () => {
  // 根因：.thinking-body 是 max-height:320px + overflow:auto 的嵌套滚动容器，
  // 思考上万字时内部滚动范围几千 px——光标落在其上时滚轮增量被它整个吃掉，
  // 对话列表定格不动。修复：流式期（实时跟随模式，钉底本就接管内滚）body 改
  // overflow:hidden，滚轮穿透链到对话区；overflow:hidden 不是滚轮手势目标但
  // 仍可编程滚动，钉底不受影响。状态契约 = 根节点 thinking--streaming 类。
  it("streaming=true 时根节点带 thinking--streaming 类（body overflow:hidden）", () => {
    const wrapper = mount(ThinkingBlock, { props: { text: "思考中", streaming: true } });
    expect(wrapper.find("details.thinking--streaming").exists()).toBe(true);
  });

  it("streaming 缺省/false 时不带类（阅读模式，body overflow:auto 原生内滚）", () => {
    const off = mount(ThinkingBlock, { props: { text: "已定稿" } });
    expect(off.find("details.thinking--streaming").exists()).toBe(false);
    const explicit = mount(ThinkingBlock, { props: { text: "已定稿", streaming: false } });
    expect(explicit.find("details.thinking--streaming").exists()).toBe(false);
  });

  it("streaming 由 true 翻 false 时类同步移除（流式结束回阅读模式）", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: "思考", streaming: true } });
    expect(wrapper.find("details.thinking--streaming").exists()).toBe(true);
    await wrapper.setProps({ streaming: false });
    expect(wrapper.find("details.thinking--streaming").exists()).toBe(false);
  });
});

describe("ThinkingBlock — details 开合（既有行为回归）", () => {
  it("流式期默认展开，结束自动折叠", async () => {
    const wrapper = mount(ThinkingBlock, { props: { text: "思考", streaming: true } });
    const details = wrapper.find("details");
    expect((details.element as HTMLDetailsElement).open).toBe(true);
    await wrapper.setProps({ streaming: false });
    expect((details.element as HTMLDetailsElement).open).toBe(false);
  });
});
