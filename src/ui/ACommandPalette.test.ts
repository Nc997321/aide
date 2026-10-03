// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ACommandPalette, { type PaletteResult } from "./ACommandPalette.vue";

const item = (id: string, group = "最近会话", action = vi.fn()): PaletteResult => ({
  id,
  label: id,
  group,
  icon: "session",
  action,
});

function mountPalette(open = false) {
  return mount(ACommandPalette, {
    props: { open },
    attachTo: document.body,
    global: { directives: { tooltip: {} } },
  });
}

describe("ACommandPalette（标题栏内联搜索，VS Code 式）", () => {
  it("输入框常驻；关闭时没有下拉面板，只有 Ctrl+P 提示", () => {
    const w = mountPalette(false);
    expect(w.find("input").exists()).toBe(true);
    expect(w.find(".a-palette-box").exists()).toBe(false);
    expect(w.find(".a-search-kbd").exists()).toBe(true);
    w.unmount();
  });

  it("聚焦 / 点击输入框请求打开（open 由父级置位）", async () => {
    const w = mountPalette(false);
    await w.find("input").trigger("focus");
    expect(w.emitted("open")).toHaveLength(1);
    await w.find("input").trigger("click");
    expect(w.emitted("open")).toHaveLength(2);
    w.unmount();
  });

  it("已打开时再聚焦不重复请求；失焦才请求关闭", async () => {
    const w = mountPalette(true);
    await w.find("input").trigger("focus");
    expect(w.emitted("open")).toBeUndefined();
    await w.find("input").trigger("blur");
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("关闭状态下的失焦不发 close", async () => {
    const w = mountPalette(false);
    await w.find("input").trigger("blur");
    expect(w.emitted("close")).toBeUndefined();
    w.unmount();
  });

  it("打开后面板在输入框下面，空查询展示最近项，Enter 执行高亮项并关闭", async () => {
    const run = vi.fn();
    const w = mountPalette(false);
    (w.vm as unknown as { setRecentFn: (f: () => Promise<PaletteResult[]>) => void }).setRecentFn(async () => [
      item("a", "最近会话", run),
      item("b", "最近文件"),
    ]);
    await w.setProps({ open: true });
    await flushPromises();
    expect(w.find(".a-palette-box").exists()).toBe(true);
    expect(w.findAll(".a-palette-item")).toHaveLength(2);
    await w.find("input").trigger("keydown", { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("方向键移动高亮；Esc 请求关闭", async () => {
    const w = mountPalette(false);
    (w.vm as unknown as { setRecentFn: (f: () => Promise<PaletteResult[]>) => void }).setRecentFn(async () => [
      item("a"),
      item("b"),
    ]);
    await w.setProps({ open: true });
    await flushPromises();
    await w.find("input").trigger("keydown", { key: "ArrowDown" });
    const rows = w.findAll(".a-palette-item");
    expect(rows[1]?.classes()).toContain("a-palette-item--selected");
    await w.find("input").trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("点结果行执行动作并关闭", async () => {
    const run = vi.fn();
    const w = mountPalette(false);
    (w.vm as unknown as { setRecentFn: (f: () => Promise<PaletteResult[]>) => void }).setRecentFn(async () => [
      item("a", "最近会话", run),
    ]);
    await w.setProps({ open: true });
    await flushPromises();
    await w.find(".a-palette-item").trigger("click");
    expect(run).toHaveBeenCalledOnce();
    expect(w.emitted("close")).toHaveLength(1);
    w.unmount();
  });

  it("中文输入法选词期间的 Enter 不执行高亮项", async () => {
    const run = vi.fn();
    const w = mountPalette(false);
    (w.vm as unknown as { setRecentFn: (f: () => Promise<PaletteResult[]>) => void }).setRecentFn(async () => [
      item("a", "最近会话", run),
    ]);
    await w.setProps({ open: true });
    await flushPromises();
    await w.find("input").trigger("keydown", { key: "Enter", isComposing: true });
    expect(run).not.toHaveBeenCalled();
    w.unmount();
  });
});
