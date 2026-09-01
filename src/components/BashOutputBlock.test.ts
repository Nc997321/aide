// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── xterm 全链 mock（vi.hoisted 保证类先于 import 可用）：只关心 write/clear 语义 ──
const t = vi.hoisted(() => {
  const calls = { write: [] as string[], clear: 0 };
  class Terminal {
    write = (s: string) => {
      calls.write.push(s);
    };
    clear = () => {
      calls.clear += 1;
    };
    open = () => {};
    loadAddon = () => {};
    dispose = () => {};
    options: Record<string, unknown> = {};
  }
  class FitAddon {
    fit = () => {};
  }
  return { calls, Terminal, FitAddon };
});
vi.mock("xterm", () => ({ Terminal: t.Terminal }));
vi.mock("xterm-addon-fit", () => ({ FitAddon: t.FitAddon }));
vi.mock("../composables/useSettings", () => ({ useSettings: () => ({ settings: { terminalFontFamily: "" } }) }));
vi.mock("../utils/xterm", () => ({ buildXtermTheme: () => ({}) }));
vi.mock("../utils/platform", () => ({ windowsPtyConfig: () => null }));

import { mount } from "@vue/test-utils";
import BashOutputBlock from "./BashOutputBlock.vue";
const { calls } = t;

describe("BashOutputBlock 增量写入", () => {
  beforeEach(() => {
    calls.write.length = 0;
    calls.clear = 0;
  });

  it("首挂：写入初始内容（含 CRLF 替换），不清屏", () => {
    mount(BashOutputBlock, { props: { content: "line1\nline2", isError: false } });
    expect(calls.write).toEqual(["line1\r\nline2"]);
    expect(calls.clear).toBe(0);
  });

  it("流式追加：只写增量后缀（不清屏、不重写全量）", async () => {
    const w = mount(BashOutputBlock, { props: { content: "head", isError: false } });
    calls.write.length = 0;
    await w.setProps({ content: "head + more" });
    expect(calls.write).toEqual([" + more"]); // 只写后缀，无 clear
    expect(calls.clear).toBe(0);
    await w.setProps({ content: "head + more\nnext" });
    expect(calls.write).toEqual([" + more", "\r\nnext"]);
    expect(calls.clear).toBe(0);
  });

  it("内容变短（revert/截断）：退回 clear + 全量重写", async () => {
    const w = mount(BashOutputBlock, { props: { content: "long output", isError: false } });
    calls.write.length = 0;
    await w.setProps({ content: "short" });
    expect(calls.clear).toBe(1);
    expect(calls.write).toEqual(["short"]);
  });

  it("全量替换（前缀不同）：clear + 全量重写，基线更新后仍纯增量", async () => {
    const w = mount(BashOutputBlock, { props: { content: "run A", isError: false } });
    calls.write.length = 0;
    await w.setProps({ content: "run B\ntail" });
    expect(calls.clear).toBe(1);
    expect(calls.write).toEqual(["run B\r\ntail"]);
    await w.setProps({ content: "run B\ntail++" });
    expect(calls.clear).toBe(1); // 未再清屏
    expect(calls.write).toEqual(["run B\r\ntail", "++"]);
  });
});