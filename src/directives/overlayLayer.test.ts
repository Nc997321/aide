// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import { defineComponent, h, withDirectives } from "vue";
import { overlayLayerOpen, vOverlayLayer } from "./overlayLayer";

enableAutoUnmount(afterEach);

/** 最小遮罩：根元素 v-if 控制 + 挂指令——与真实遮罩组件（`<div v-if="visible" v-overlay-layer>`）同形。
 *  用渲染函数 + `withDirectives` 而非 runtime template：测试环境不保证带模板编译器。 */
const Overlay = defineComponent({
  props: { on: { type: Boolean, default: false } },
  setup(props) {
    return () =>
      props.on
        ? withDirectives(h("div", { class: "x-overlay" }), [[vOverlayLayer]])
        : null;
  },
});

/** 宿主：连组件一起 v-if 掉，验证「组件卸载」这条路径（不等同于元素 v-if）。 */
const Host = defineComponent({
  props: { show: { type: Boolean, default: false } },
  setup(props) {
    return () => (props.show ? h(Overlay, { on: true }) : null);
  },
});

describe("浮层登记处", () => {
  it("遮罩根元素进出 DOM = 浮层开与关（v-if 契约）", async () => {
    const w = mount(Overlay, { props: { on: false } });
    expect(overlayLayerOpen.value).toBe(false);

    await w.setProps({ on: true });
    expect(overlayLayerOpen.value).toBe(true);

    await w.setProps({ on: false });
    expect(overlayLayerOpen.value).toBe(false);
  });

  it("多个遮罩并存各记各的：关掉一个不许把另一个也注销", async () => {
    const a = mount(Overlay, { props: { on: true } });
    const b = mount(Overlay, { props: { on: true } });
    expect(overlayLayerOpen.value).toBe(true);

    await a.setProps({ on: false });
    expect(overlayLayerOpen.value).toBe(true); // b 还开着

    await b.setProps({ on: false });
    expect(overlayLayerOpen.value).toBe(false);
  });

  it("组件卸载 = 注销（元素 v-if 之外的兜底路径）", async () => {
    const w = mount(Host, { props: { show: true } });
    expect(overlayLayerOpen.value).toBe(true);

    await w.setProps({ show: false });
    expect(overlayLayerOpen.value).toBe(false);
  });
});
