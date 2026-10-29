// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import AInput from "./AInput.vue";
import type { AInputHandle } from "./input";

describe("AInput", () => {
  it("统一关闭补全，透传输入属性、样式和原生事件", async () => {
    const input = vi.fn();
    const w = mount(AInput, { props: { unstyled: true }, attrs: {
      class: "text-input", placeholder: "模型", disabled: false, "aria-label": "模型", onInput: input,
    } });
    expect(w.element.tagName).toBe("INPUT");
    expect(w.attributes()).toMatchObject({ autocomplete: "off", class: "text-input", placeholder: "模型", "aria-label": "模型" });
    await w.find("input").setValue("deepseek");
    expect(w.emitted("update:modelValue")?.[0]).toEqual(["deepseek"]);
    expect((input.mock.calls[0][0] as Event).target).toBe(w.element);
    w.unmount();
  });

  it("用户名、密码可显式声明自动填充策略，动态类型随状态切换", async () => {
    const w = mount(AInput, { props: { type: "password", autocomplete: "new-password" } });
    expect(w.attributes()).toMatchObject({ type: "password", autocomplete: "new-password" });
    await w.setProps({ type: "text" });
    expect(w.attributes("type")).toBe("text");
    w.unmount();
  });

  it("双向绑定、trim、number 和 lazy 保持原生输入语义", async () => {
    const Host = defineComponent({ components: { AInput }, setup: () => ({ text: ref(""), count: ref(1), lazy: ref("") }),
      template: '<div><AInput v-model.trim="text" /><AInput type="number" v-model.number="count" /><AInput v-model.lazy="lazy" /><p>{{ text }}|{{ count }}|{{ lazy }}</p></div>',
    });
    const w = mount(Host);
    const inputs = w.findAll("input");
    await inputs[0].setValue(" model ");
    await inputs[1].setValue("3");
    expect(w.vm.text).toBe("model");
    expect(w.vm.count).toBe(3);
    (inputs[2].element as HTMLInputElement).value = "deferred";
    await inputs[2].trigger("input");
    expect(w.vm.lazy).toBe("");
    await inputs[2].trigger("change");
    expect(w.vm.lazy).toBe("deferred");
    w.unmount();
  });

  it("中文组合输入完成才更新模型，完成事件仍传给调用方", async () => {
    const input = vi.fn();
    const w = mount(AInput, { props: { modelValue: "" }, attrs: { onInput: input } });
    await w.trigger("compositionstart");
    (w.element as HTMLInputElement).value = "供应商";
    await w.trigger("input");
    expect(w.emitted("update:modelValue")).toBeUndefined();
    await w.trigger("compositionend");
    expect(w.emitted("update:modelValue")).toEqual([["供应商"]]);
    expect(input).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it("暴露聚焦、选中和原生元素，支持已有焦点判断", async () => {
    const w = mount(AInput, { props: { modelValue: "model" }, attachTo: document.body });
    const handle = w.vm as unknown as AInputHandle;
    handle.focus();
    expect(document.activeElement).toBe(handle.element);
    handle.select();
    expect(handle.element?.selectionEnd).toBe(5);
    handle.blur();
    expect(document.activeElement).not.toBe(handle.element);
    w.unmount();
  });
});
