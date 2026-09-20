// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { nextTick, ref } from "vue";
import { useResizable, staticWidthSource, type WidthSource } from "./useResizable";

const VAR = "--t-w";

function cssVar(): string {
  return document.documentElement.style.getPropertyValue(VAR);
}

/** 可切档的桩 source：`active` 读一个 ref，切档 = 改 ref。 */
function twoProfileSource() {
  const active = ref("narrow");
  const store: Record<string, number> = { narrow: 0, browser: 0 };
  const source: WidthSource = {
    active: () => active.value,
    limits: (name) =>
      name === "browser"
        ? { initial: () => 800, min: 420, max: () => 1000 }
        : { initial: 340, min: 300, max: 540 },
    get: (name) => store[name] ?? 0,
    set: (name, px) => {
      store[name] = px;
    },
  };
  return { source, active, store };
}

beforeEach(() => {
  document.documentElement.style.removeProperty(VAR);
});

describe("useResizable · 落值", () => {
  it("挂上就把当前档的初始值写进 CSS 变量", () => {
    const { source } = twoProfileSource();
    useResizable({ cssVar: VAR, direction: "right", source });
    expect(cssVar()).toBe("340px");
  });

  it("切档 → 写新档的值（切档靠 source.active 的响应式读触发）", async () => {
    const { source, active } = twoProfileSource();
    useResizable({ cssVar: VAR, direction: "right", source });
    active.value = "browser";
    await nextTick();
    expect(cssVar()).toBe("800px");
  });

  it("已记的值优先于 initial", async () => {
    const { source, active, store } = twoProfileSource();
    store.browser = 640;
    useResizable({ cssVar: VAR, direction: "right", source });
    active.value = "browser";
    await nextTick();
    expect(cssVar()).toBe("640px");
  });
});

describe("useResizable · 拖动", () => {
  it("direction=right：向左拖变大，并把值写回 source", () => {
    const { source, store } = twoProfileSource();
    const r = useResizable({ cssVar: VAR, direction: "right", source });
    r.onMousedown(new MouseEvent("mousedown", { clientX: 500 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    expect(cssVar()).toBe("440px"); // 340 + 100
    expect(store.narrow).toBe(440);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 400 }));
  });

  it("direction=left：向右拖变大", () => {
    const { source, store } = twoProfileSource();
    const r = useResizable({ cssVar: VAR, direction: "left", source });
    r.onMousedown(new MouseEvent("mousedown", { clientX: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 360 }));
    expect(store.narrow).toBe(400);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 360 }));
  });

  it("clamp 到上下限", () => {
    const { source, store } = twoProfileSource();
    const r = useResizable({ cssVar: VAR, direction: "right", source });
    r.onMousedown(new MouseEvent("mousedown", { clientX: 0 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -5000 }));
    expect(store.narrow).toBe(540); // 上限
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 5000 }));
    expect(store.narrow).toBe(300); // 下限
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 5000 }));
  });

  it("max < min（窗口过窄）时按 min 收", () => {
    const store = { narrow: 0 };
    const source: WidthSource = {
      active: () => "narrow",
      limits: () => ({ initial: 340, min: 420, max: () => 300 }),
      get: () => store.narrow,
      set: (_name, px) => {
        store.narrow = px;
      },
    };
    const r = useResizable({ cssVar: VAR, direction: "right", source });
    expect(cssVar()).toBe("420px");
    r.onMousedown(new MouseEvent("mousedown", { clientX: 500 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }));
    expect(store.narrow).toBe(420);
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 100 }));
  });

  it("mouseup 之后不再改值", () => {
    const { source, store } = twoProfileSource();
    const r = useResizable({ cssVar: VAR, direction: "right", source });
    r.onMousedown(new MouseEvent("mousedown", { clientX: 500 }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 500 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 100 }));
    expect(store.narrow).toBe(0);
    expect(r.isDragging.value).toBe(false);
  });
});

describe("staticWidthSource（单档，给左侧栏用）", () => {
  it("自带记忆：拖动写回，值留在 source 里", () => {
    const src = staticWidthSource({ initial: 280, min: 220, max: 450 });
    const r = useResizable({ cssVar: VAR, direction: "left", source: src });
    expect(cssVar()).toBe("280px");
    r.onMousedown(new MouseEvent("mousedown", { clientX: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    document.dispatchEvent(new MouseEvent("mouseup", { clientX: 400 }));
    expect(src.get("default")).toBe(380);
  });
});
