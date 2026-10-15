// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

const openResolved = vi.fn();
vi.mock("@/composables/useFileResolver", () => ({ useFileResolver: () => ({ openResolved }) }));

import LspGlanceNote from "./LspGlanceNote.vue";
import type { LspGlanceItem } from "@/types/chat";

const items: LspGlanceItem[] = [
  { kind: "definition", name: "run_jump", file: "src/a.rs", line: 10, symbolKind: "function", endLine: 90 },
  { kind: "summary", name: "ask_language", defs: [{ file: "src/b.rs", line: 5, kind: "function" }], refCount: 0, refFiles: 0 },
  {
    kind: "references",
    name: "getUserInfo",
    total: 20,
    shown: [{ file: "src/c.ts", line: 3, enclosing: "MediaService.load" }],
  },
];

const mountIt = () =>
  mount(LspGlanceNote, {
    props: { items, workspacePath: "/ws" },
    global: { directives: { tooltip: {} } },
  });

describe("LspGlanceNote", () => {
  it("收起时是一枚药丸：个数 + 附了什么", () => {
    const w = mountIt();
    expect(w.find(".lg-pill").text()).toBe("LSP 补充 · 3 个符号 · 附函数体");
    expect(w.find(".lg-list").exists()).toBe(false);
  });

  it("点开：定义区间 / 确认没有引用 / 引用条数与所在函数，中文显示", async () => {
    const w = mountIt();
    await w.find(".lg-pill").trigger("click");
    const text = w.find(".lg-list").text();
    expect(text).toContain("函数");
    expect(text).toContain("src/a.rs:10–90");
    expect(text).toContain("没有任何引用（已确认）");
    expect(text).toContain("20 处引用（附了前 1 条）");
    expect(text).toContain("在 MediaService.load");
  });

  it("路径可点：按会话工作区打开并定位到行", async () => {
    const w = mountIt();
    await w.find(".lg-pill").trigger("click");
    await w.findAll(".lg-path")[0].trigger("click");
    expect(openResolved).toHaveBeenCalledWith("src/a.rs", "/ws", 10);
  });
});
