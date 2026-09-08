// @vitest-environment jsdom
// isFontInstalled 纯函数行为（注入假 measure）+ jsdom 无 canvas 环境的真实
// 降级路径 + 真实组件在「全部未装」下的自定义输入流程。探测桩化的组件行为
// 见 FontSelect.test.ts。
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import {
  isFontInstalled,
  CJK_MONO_FALLBACK,
  type FontMeasurer,
} from "@aide/sdk/utils/fonts";
import FontSelect from "./FontSelect.vue";

describe("isFontInstalled（纯函数，注入假 measure）", () => {
  /** 严格假 measure：按 font 规格精确返回预置宽度，未预期的规格直接抛错
   *  ——防止假实现的宽度模型静默偏离真实字体回退语义。 */
  function measureFrom(widths: Record<string, number>): FontMeasurer {
    return (spec) => {
      const w = widths[spec];
      if (w === undefined) throw new Error("unexpected measure spec: " + spec);
      return w;
    };
  }

  it("已装普通字体：候选,sans 渲染候选字形，异于 sans 对照 → 已安装", () => {
    const measure = measureFrom({
      '72px "Maple Mono NF CN", sans-serif': 120,
      "72px sans-serif": 100,
    });
    expect(isFontInstalled("Maple Mono NF CN", measure)).toBe(true);
  });

  it("已装且恰为 generic monospace 本尊（Windows Consolas）：sans 对照不等宽 → 已安装", () => {
    const measure = measureFrom({
      '72px "Consolas", sans-serif': 100, // Consolas 自己的字形
      "72px sans-serif": 140,
    });
    expect(isFontInstalled("Consolas", measure)).toBe(true);
  });

  it("缺失（mono≠sans 也必须 false）：两个回退位都落对照本体、同宽 → 未安装", () => {
    const measure = measureFrom({
      '72px "NoSuch Font", sans-serif': 140, // 落 generic sans
      "72px sans-serif": 140,
      '72px "NoSuch Font", monospace': 100, // 落 generic mono
      "72px monospace": 100,
    });
    expect(isFontInstalled("NoSuch Font", measure)).toBe(false);
  });

  it("已装且恰为 generic sans 本尊（macOS Helvetica 类）：sans 对照同宽、mono 对照兜住 → 已安装", () => {
    const measure = measureFrom({
      '72px "Helvetica", sans-serif': 140, // 与 sans 对照同宽
      "72px sans-serif": 140,
      '72px "Helvetica", monospace': 140, // 但异于 mono 对照
      "72px monospace": 100,
    });
    expect(isFontInstalled("Helvetica", measure)).toBe(true);
  });

  it("font 规格必须给带空格的家族名加引号（否则解析成多个家族）", () => {
    const specs: string[] = [];
    isFontInstalled("Maple Mono NF CN", (spec) => {
      specs.push(spec);
      return 0;
    });
    expect(specs.some((s) => s.includes('"Maple Mono NF CN"'))).toBe(true);
  });
});

describe("jsdom 无 canvas 降级（真实组件 + 真探测）", () => {
  let wrapper: VueWrapper | undefined;
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
  });

  it("getContext 不可用 → 全部判未装，只列自定义…；自定义输入流程完好", async () => {
    wrapper = mount(FontSelect, {
      props: { modelValue: "monospace" },
      global: { directives: { tooltip: () => {} } },
    });
    await nextTick();
    await wrapper.find("button.themed-select").trigger("click");
    await nextTick();
    const options = document.body.querySelectorAll(".themed-select-option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("自定义…");

    // 降级环境下自定义输入仍完整可用（探测失效 ≠ 功能失效）
    const input = wrapper.find("input.custom-input");
    await input.setValue("Maple Mono NF CN");
    await input.trigger("input");
    const emittedValue = wrapper.emitted("update:modelValue")?.at(-1)?.[0];
    expect(emittedValue).toBe("'Maple Mono NF CN', " + CJK_MONO_FALLBACK);
    await wrapper.setProps({ modelValue: emittedValue ?? "" });
    const el = wrapper.find("input.custom-input").element;
    expect(el instanceof HTMLInputElement && el.value).toBe("Maple Mono NF CN");
  });

  it("桩掉 getContext 返回可用 2d 上下文 → measure 走真度量、探测命中候选", async () => {
    // jsdom 没有 canvas 实现；只实现 measure 适配层消费的 font/measureText
    // 两个成员，其余成员缺失——类型系统无法表达这种部分桩，断言豁免见 X2。
    // 判别键是 ctx.font 规格（探针文本恒定），候选名在 font 里。
    const ctxStub = {
      font: "",
      measureText() {
        return { width: this.font.includes("Maple") ? 120 : 100 };
      },
    };
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctxStub as unknown as CanvasRenderingContext2D);
    try {
      wrapper = mount(FontSelect, {
        props: { modelValue: "'Maple Mono NF CN', " + CJK_MONO_FALLBACK },
        global: { directives: { tooltip: () => {} } },
      });
      await nextTick();
      expect(wrapper.find(".themed-select-label").text()).toBe("Maple Mono NF CN");
      expect(wrapper.find("input.custom-input").exists()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});