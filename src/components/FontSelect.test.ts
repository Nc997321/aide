// @vitest-environment jsdom
// FontSelect：候选探测 → 下拉列表、选中态定形精确匹配、自定义输入防回写。
// isFontInstalled（@aide/sdk/utils/fonts）打桩控制探测结果；真实现行为与
// jsdom 无 canvas 降级见 FontSelect.detect.test.ts。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";

vi.mock("@aide/sdk/utils/fonts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aide/sdk/utils/fonts")>();
  return { ...actual, isFontInstalled: vi.fn() };
});

import { isFontInstalled, CJK_MONO_FALLBACK } from "@aide/sdk/utils/fonts";
import FontSelect from "./FontSelect.vue";

const probeMock = vi.mocked(isFontInstalled);

const stackOf = (name: string) => `'${name}', ${CJK_MONO_FALLBACK}`;
const JETBRAINS_STACK = stackOf("JetBrains Mono");
// 上一代默认等宽栈字面量（多字体非定形形态）——应落自定义
const MONO_DEFAULT =
  "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'PingFang SC', 'Microsoft YaHei', monospace";

function mountSelect(modelValue: string, onlyJetBrains = false): VueWrapper {
  probeMock.mockImplementation((_name) =>
    onlyJetBrains ? _name === "JetBrains Mono" : false,
  );
  return mount(FontSelect, {
    props: { modelValue },
    global: { directives: { tooltip: () => {} } },
  });
}

function labelOf(w: VueWrapper): string {
  return w.find(".themed-select-label").text();
}

function customValueOf(w: VueWrapper): string {
  const el = w.find("input.custom-input").element;
  return el instanceof HTMLInputElement ? el.value : "";
}

function lastEmitted(w: VueWrapper): string | undefined {
  return w.emitted("update:modelValue")?.at(-1)?.[0];
}

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = "";
});

describe("选中态解析（定形精确匹配）", () => {
  beforeEach(() => probeMock.mockReset());

  it("定形栈精确命中候选 → 下拉显示该字体，不产生 emit", async () => {
    wrapper = mountSelect(JETBRAINS_STACK, true);
    await nextTick();
    expect(labelOf(wrapper)).toBe("JetBrains Mono");
    expect(wrapper.find("input.custom-input").exists()).toBe(false);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("非定形栈（默认多字体栈）→ 落自定义…，输入框回显原始值", async () => {
    wrapper = mountSelect(MONO_DEFAULT);
    await nextTick();
    expect(labelOf(wrapper)).toBe("自定义…");
    expect(customValueOf(wrapper)).toBe(MONO_DEFAULT);
  });
});

describe("自定义输入防回写", () => {
  beforeEach(() => probeMock.mockReset());

  it("输入单字体名 → emit 垫回退的定形栈，echo 回灌后输入框不被改写", async () => {
    wrapper = mountSelect("monospace");
    await nextTick();
    const input = wrapper.find("input.custom-input");
    await input.setValue("Maple Mono NF CN");
    await input.trigger("input");
    expect(lastEmitted(wrapper)).toBe(stackOf("Maple Mono NF CN"));

    // 模拟父层 v-model 回灌（真实 bug：回灌触发 watcher 把输入框整栈覆盖）
    await wrapper.setProps({ modelValue: stackOf("Maple Mono NF CN") });
    expect(customValueOf(wrapper)).toBe("Maple Mono NF CN");
    expect(labelOf(wrapper)).toBe("自定义…");
  });

  it("输入含逗号的完整栈 → 原样透传", async () => {
    wrapper = mountSelect("monospace");
    await nextTick();
    const input = wrapper.find("input.custom-input");
    await input.setValue("'A', 'B', monospace");
    await input.trigger("input");
    expect(lastEmitted(wrapper)).toBe("'A', 'B', monospace");
  });

  it("输入清空（trim 后为空）→ 不 emit", async () => {
    wrapper = mountSelect("monospace");
    await nextTick();
    const input = wrapper.find("input.custom-input");
    await input.setValue("   ");
    await input.trigger("input");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("外部改动（非本组件 emit）→ 重新解析选中项", async () => {
    wrapper = mountSelect("monospace", true);
    await nextTick();
    await wrapper.setProps({ modelValue: JETBRAINS_STACK });
    expect(labelOf(wrapper)).toBe("JetBrains Mono");
    expect(wrapper.find("input.custom-input").exists()).toBe(false);
  });

  it("echo 过期：emit 后外部又改成别的值 → 照常重新解析", async () => {
    wrapper = mountSelect("monospace");
    await nextTick();
    const input = wrapper.find("input.custom-input");
    await input.setValue("Maple Mono NF CN");
    await input.trigger("input");
    // 紧随 emit 的外部改动（≠ lastEmitted）→ 不能被 echo 守卫误吞
    await wrapper.setProps({ modelValue: MONO_DEFAULT });
    expect(customValueOf(wrapper)).toBe(MONO_DEFAULT);
    expect(labelOf(wrapper)).toBe("自定义…");
  });

  it("modelValue 为空串 → 自定义输入框回显空", async () => {
    wrapper = mountSelect("");
    await nextTick();
    expect(labelOf(wrapper)).toBe("自定义…");
    expect(customValueOf(wrapper)).toBe("");
  });
});

describe("下拉选择", () => {
  beforeEach(() => probeMock.mockReset());

  it("点击候选 → emit 定形栈；回灌后不回跳自定义", async () => {
    wrapper = mountSelect("monospace", true);
    await nextTick();
    await wrapper.find("button.themed-select").trigger("click");
    await nextTick();
    const option = Array.from(
      document.body.querySelectorAll(".themed-select-option"),
    ).find((el) => el.textContent?.includes("JetBrains Mono"));
    expect(option).toBeTruthy();
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(lastEmitted(wrapper)).toBe(JETBRAINS_STACK);

    // 父层回灌 → 定形命中，选中态稳定在候选上（旧 bug 此处跳回自定义/YaHei）
    await wrapper.setProps({ modelValue: JETBRAINS_STACK });
    expect(labelOf(wrapper)).toBe("JetBrains Mono");
  });

  it("程序性选中（外部值恰好等于定形栈）不重复 emit", async () => {
    wrapper = mountSelect(JETBRAINS_STACK, true);
    await nextTick();
    // onMounted → syncFromModel 设 selectedValue → selectedValue watcher
    // 命中同值守卫，不应发 emit
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("下拉点「自定义…」→ 落自定义，输入框回显当前栈", async () => {
    wrapper = mountSelect(JETBRAINS_STACK, true);
    await nextTick();
    await wrapper.find("button.themed-select").trigger("click");
    await nextTick();
    const option = Array.from(
      document.body.querySelectorAll(".themed-select-option"),
    ).find((el) => el.textContent?.includes("自定义…"));
    expect(option).toBeTruthy();
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(labelOf(wrapper)).toBe("自定义…");
    expect(customValueOf(wrapper)).toBe(JETBRAINS_STACK);
  });

  it("外部清空 modelValue（候选 → 空串）→ 自定义输入框回显空串", async () => {
    // selectedValue 从候选跳到 __custom__ 触发 watcher，且 modelValue 为空
    // ——覆盖 watcher 内 `|| ""` 的空臂（syncFromModel 直设路径走的是 80 行）
    wrapper = mountSelect(JETBRAINS_STACK, true);
    await nextTick();
    await wrapper.setProps({ modelValue: "" });
    expect(labelOf(wrapper)).toBe("自定义…");
    expect(customValueOf(wrapper)).toBe("");
  });
});