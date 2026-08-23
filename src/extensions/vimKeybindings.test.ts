// @vitest-environment jsdom
// vimKeybindings 单测：映射应用/撤销（mock Vim.map/unmap 捕获）、ex 目标解析、
// 键串转换。拦截器行为走 CodeEditor.vim.test.ts 集成测试（需真实 EditorView）。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@replit/codemirror-vim", () => ({
  Vim: { map: vi.fn(), unmap: vi.fn() },
  getCM: vi.fn(),
}));

import { Vim } from "@replit/codemirror-vim";
import {
  applyVimKeyMaps,
  clearVimKeyMaps,
  isExTarget,
  exToCommand,
  eventToVimKey,
  type VimBindings,
} from "./vimKeybindings";

const mapMock = vi.mocked(Vim.map);
const unmapMock = vi.mocked(Vim.unmap);

beforeEach(() => {
  // 先兜底清 applied：残留清理的 unmap 调用发生在 mockClear 之前，不污染本测试计数
  unmapMock.mockReturnValue(false);
  clearVimKeyMaps();
  mapMock.mockClear();
  unmapMock.mockClear();
});

const b = (keys: string, to: string) => ({ keys, to });

describe("applyVimKeyMaps / clearVimKeyMaps", () => {
  it("maps_key_targets_with_mode_context", () => {
    applyVimKeyMaps({
      normal: [b("jj", "<Esc>"), b("G", "$")],
      insert: [b("jk", "<Esc>")],
      visual: [b("v", "<Esc>")],
    });
    expect(mapMock).toHaveBeenNthCalledWith(1, "jj", "<Esc>", "normal");
    expect(mapMock).toHaveBeenNthCalledWith(2, "G", "$", "normal");
    expect(mapMock).toHaveBeenNthCalledWith(3, "jk", "<Esc>", "insert");
    expect(mapMock).toHaveBeenNthCalledWith(4, "v", "<Esc>", "visual");
  });

  it("skips_empty_keys_and_ex_targets", () => {
    applyVimKeyMaps({
      normal: [b("", "<Esc>"), b("<C-s>", ":w")],
      insert: [],
      visual: [],
    });
    expect(mapMock).not.toHaveBeenCalled();
  });

  it("clear_unmaps_all_applied_mappings", () => {
    applyVimKeyMaps({
      normal: [b("jj", "<Esc>"), b("x", "dd")],
      insert: [],
      visual: [],
    });
    clearVimKeyMaps();
    expect(unmapMock).toHaveBeenCalledTimes(2);
    expect(unmapMock).toHaveBeenNthCalledWith(1, "jj", "normal");
    expect(unmapMock).toHaveBeenNthCalledWith(2, "x", "normal");
  });

  it("reapply_first_clears_previous", () => {
    applyVimKeyMaps({ normal: [b("jj", "<Esc>")], insert: [], visual: [] });
    applyVimKeyMaps({ normal: [b("kk", "<Esc>")], insert: [], visual: [] });
    expect(unmapMock).toHaveBeenCalledWith("jj", "normal");
    expect(mapMock).toHaveBeenCalledWith("kk", "<Esc>", "normal");
    expect(mapMock).toHaveBeenCalledTimes(2); // jj（第一次 apply）+ kk（第二次）
    expect(mapMock.mock.calls[1]).toEqual(["kk", "<Esc>", "normal"]); // 重打只注册新键
  });

  it("clear_loops_duplicate_mappings", () => {
    // 同键被 map 两次（defaultKeymap 两条用户条目）→ unmap 循环删到删不动
    unmapMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    applyVimKeyMaps({ normal: [b("x", "dd")], insert: [], visual: [] });
    // 伪造同键二次注册（真实路径由重复 apply 产生，此处直接模拟 unmap 多条目）
    clearVimKeyMaps();
    expect(unmapMock).toHaveBeenCalledTimes(3);
  });
});

describe("exToCommand / isExTarget", () => {
  it("parses_builtin_ex_commands", () => {
    expect(exToCommand(":w")).toBe("w");
    expect(exToCommand(":wq")).toBe("wq");
    expect(exToCommand(":q")).toBe("q");
    expect(exToCommand(":q!")).toBe("q!");
  });

  it("unknown_or_non_ex_targets_return_null", () => {
    expect(exToCommand(":nope")).toBeNull();
    expect(exToCommand("<Esc>")).toBeNull();
  });

  it("is_ex_target_starts_with_colon", () => {
    expect(isExTarget(":w")).toBe(true);
    expect(isExTarget("<Esc>")).toBe(false);
  });
});

describe("eventToVimKey", () => {
  const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

  it("plain_letter_lowercased", () => {
    expect(eventToVimKey(ev({ key: "x" }))).toBe("x");
    expect(eventToVimKey(ev({ key: "X", shiftKey: true }))).toBe("x"); // shift 不显式
  });

  it("modifier_combo_wrapped_in_angles", () => {
    expect(eventToVimKey(ev({ key: "s", ctrlKey: true }))).toBe("<C-s>");
    expect(eventToVimKey(ev({ key: "m", ctrlKey: true, altKey: true }))).toBe("<C-A-m>");
    expect(eventToVimKey(ev({ key: "g", metaKey: true }))).toBe("<M-g>");
  });

  it("special_keys_normalized", () => {
    expect(eventToVimKey(ev({ key: "Escape" }))).toBe("<Esc>");
    expect(eventToVimKey(ev({ key: "Enter" }))).toBe("<CR>");
    expect(eventToVimKey(ev({ key: " " }))).toBe("<Space>");
    expect(eventToVimKey(ev({ key: "ArrowDown" }))).toBe("<Down>");
    expect(eventToVimKey(ev({ key: "Backspace", ctrlKey: true }))).toBe("<C-BS>");
  });

  it("unrecognizable_key_returns_empty", () => {
    expect(eventToVimKey(ev({ key: "Shift" }))).toBe("");
    expect(eventToVimKey(ev({ key: "Alt" }))).toBe("");
  });
});
