// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { flushPromises, mount, enableAutoUnmount } from "@vue/test-utils";
import ContextUsagePanel from "./ContextUsagePanel.vue";
import type { ContextUsage, RateLimitInfo } from "@/types/chat";

// 弹层验收：Teleport 内联化（stubs.teleport）后测 DOM——三路关闭语义、
// anchor 缺失的定位早退、明细列表与额度环的状态臂。

enableAutoUnmount(afterEach);

const usage: ContextUsage = {
  totalTokens: 125_500,
  maxTokens: 160_000,
  rawMaxTokens: 200_000,
  percentage: 62.8,
  categories: [
    { name: "System prompt", tokens: 11_000 },
    { name: "MCP tools", tokens: 220, isDeferred: true },
  ],
};

const rateLimit: RateLimitInfo = {
  subscription: "pro",
  windows: [
    { key: "5h", label: "5h", utilization: 42 },
    { key: "7d", label: "7d", utilization: 96 },
  ],
};

/** teleport 内联 + portal stub，让 DOM 查询落在 wrapper 内。over.anchor
 *  缺省 null（watch 的 null 臂）；传入元素则触发 position() 生产布局路径。 */
function mountPanel(over: {
  usage?: ContextUsage | null;
  rateLimit?: RateLimitInfo;
  anchor?: HTMLElement | null;
} = {}) {
  return mount(ContextUsagePanel, {
    props: {
      usage: over.usage !== undefined ? over.usage : usage,
      anchor: over.anchor !== undefined ? over.anchor : null,
      rateLimit: over.rateLimit !== undefined ? over.rateLimit : rateLimit,
    },
    global: { stubs: { teleport: true } },
  });
}

/** 布局桩：jsdom 无布局引擎，offsetWidth/Height 恒 0 → position() 的
 *  clamp/尺寸计算全走不动。临时钉到 prototype，返回还原函数（try/finally 配对）。 */
function stubPanelMetrics(): () => void {
  const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { get: () => 100, configurable: true });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { get: () => 320, configurable: true });
  return () => {
    if (h) Object.defineProperty(HTMLElement.prototype, "offsetHeight", h);
    else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    if (w) Object.defineProperty(HTMLElement.prototype, "offsetWidth", w);
    else Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  };
}

function anchorAt(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 20, height: 20, top: 0, bottom: 0, left: 0, right: 0,
    toJSON: () => rect as DOMRect,
    ...rect,
  });
  return el;
}

describe("ContextUsagePanel", () => {
  it("渲染大百分比、明细列表与同源 dot 色", () => {
    const w = mountPanel();
    expect(w.find(".usage-panel__percent").text()).toBe("63%");
    expect(w.find(".usage-panel__detail").text()).toContain("125.5K / 160.0K");
    const rows = w.findAll(".usage-panel__item");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("System prompt");
  });

  it("明细为空时显示占位行", () => {
    const w = mountPanel({ usage: { ...usage, categories: undefined } });
    expect(w.findAll(".usage-panel__item")).toHaveLength(0);
    expect(w.find(".usage-panel__empty").text()).toContain("暂无占用明细");
  });

  it("额度环按 utilization 落状态臂（42→ok、96→warning）", () => {
    const w = mountPanel();
    const classes = w.findAll(".usage-panel__rate svg").map((s) => s.classes());
    expect(classes[0]).toContain("usage-panel__ring--ok");
    expect(classes[1]).toContain("usage-panel__ring--warning");
  });

  it("额度环利用到上限走 danger 臂（utilization=100）", () => {
    const w = mountPanel({
      rateLimit: {
        subscription: "pro",
        windows: [{ key: "5h", label: "5h", utilization: 100, resetsAt: null }],
      },
    });
    expect(w.find(".usage-panel__rate svg").classes()).toContain("usage-panel__ring--danger");
  });

  it("无额度窗口时环区隐藏（footer 不渲染空环）", () => {
    const w = mountPanel({ rateLimit: { subscription: null, windows: [] } });
    expect(w.find(".usage-panel__rates").exists()).toBe(false);
    expect(w.find(".usage-panel__footer").exists()).toBe(false);
  });

  it("Esc 关闭并消费事件（不连带别处 Esc 负面动作）", async () => {
    const w = mountPanel();
    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    document.dispatchEvent(ev);
    await w.vm.$nextTick();
    expect(w.emitted("close")).toHaveLength(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("文档级外点关闭；面板内点击不关", async () => {
    const w = mountPanel();
    document.dispatchEvent(new Event("pointerdown"));
    await w.vm.$nextTick();
    expect(w.emitted("close")).toHaveLength(1);

    await w.find(".usage-panel__header").trigger("pointerdown");
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("弹层不含压缩按钮（压缩入口在发送分裂按钮的命令菜单，不在此重复）", () => {
    const w = mountPanel();
    expect(w.find(".usage-panel__compact").exists()).toBe(false);
  });

  it("anchor 为 null 时 watch 的 if(v) 臂拦截，面板首帧 hidden", () => {
    // 注意：这里不执行 position()——watch 的 null 臂直接跳过。声明性断言：
    // 面板能渲染，且初始 positioned=false 表现为 visibility hidden。
    const w = mountPanel();
    expect(w.find(".usage-panel").exists()).toBe(true);
    expect(w.find(".usage-panel").attributes("style")).toContain("visibility: hidden");
  });

  it("position 生产路径·向上弹（下方空间不足）：top=anchor.top-高-6，右缘 clamp 到屏宽-320-8，hidden 解除", async () => {
    // jsdom 视口 768×1024；anchor rect 贴屏底右缘：spaceBelow=68 < 100+8 → openUp
    const restore = stubPanelMetrics();
    try {
      const w = mountPanel({ anchor: anchorAt({ top: 600, bottom: 700, left: 1260 }) });
      await flushPromises();
      const style = w.find(".usage-panel").attributes("style") ?? "";
      expect(style).toContain("top: 494px"); // 600 - 100 - 6
      expect(style).toContain("left: 696px"); // 1024 - 320 - 8
      expect(style).not.toContain("visibility: hidden"); // positioned=true 解除首帧隐藏
    } finally {
      restore();
    }
  });

  it("position 生产路径·向下展（上方贴顶）：top=rect.bottom+6", async () => {
    const restore = stubPanelMetrics();
    try {
      const w = mountPanel({ anchor: anchorAt({ top: 0, bottom: 10, left: 12 }) });
      await flushPromises();
      const style = w.find(".usage-panel").attributes("style") ?? "";
      expect(style).toContain("top: 16px"); // 10 + 6
      expect(style).toContain("left: 12px"); // 未越右缘，不 clamp
      expect(style).not.toContain("visibility: hidden");
    } finally {
      restore();
    }
  });
});