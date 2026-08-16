// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// useFileViewer mock 必须是单例：组件内部调用与测试断言共享同一个 vi.fn()，
// 否则每次 useFileViewer() 都新建 mock，断言永远落空。
const { openAndScrollTo } = vi.hoisted(() => ({ openAndScrollTo: vi.fn() }));

vi.mock("../api", () => ({
  api: {
    searchInFiles: vi.fn(),
    replaceInFilesPreview: vi.fn(),
    applyReplacements: vi.fn(),
  },
}));

vi.mock("../composables/useFileViewer", () => ({
  useFileViewer: () => ({ openAndScrollTo }),
}));

import SearchPanel from "./SearchPanel.vue";
import { api } from "../api";
import { useFileViewer } from "../composables/useFileViewer";

const EMPTY = { files: [], total: 0, truncated: false };

function group(file: string, line = 1, lineText = "const foo = 1;") {
  return {
    file,
    matches: [{ file, line, column: 7, lineText, matchStart: 6, matchEnd: 9 }],
  };
}

describe("SearchPanel 搜索模式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("渲染输入框与选项行", () => {
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    expect(wrapper.find("input.search-input").exists()).toBe(true);
    expect(wrapper.find("input.mask-input").exists()).toBe(true);
    expect(wrapper.text()).toContain("正则");
  });

  it("防抖 300ms 后调用 searchInFiles", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue(EMPTY);
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("foo");
    expect(api.searchInFiles).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(api.searchInFiles).toHaveBeenCalledWith(
      "foo",
      "/ws",
      expect.objectContaining({ useRegex: false, caseSensitive: false, wholeWord: false, fileMask: null, limit: 500 }),
    );
  });

  it("竞态：旧请求返回时被丢弃", async () => {
    vi.useFakeTimers();
    let resolveFirst: (v: unknown) => void = () => {};
    const first = new Promise((r) => { resolveFirst = r; });
    (api.searchInFiles as any)
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ files: [group("new.ts")], total: 1, truncated: false });
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    await wrapper.find("input.search-input").setValue("foobar");
    vi.advanceTimersByTime(300);
    await flushPromises();
    // 旧请求（seq=1）现在才返回，应被丢弃——UI 只显示新请求（seq=2）的 new.ts
    resolveFirst({ files: [group("old.ts")], total: 1, truncated: false });
    await flushPromises();
    expect(wrapper.text()).toContain("new.ts");
    expect(wrapper.text()).not.toContain("old.ts");
  });

  it("渲染分组结果，点击匹配行跳转文件", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue({
      files: [group("src/a.ts"), group("src/b.vue", 3, "foo bar")],
      total: 2,
      truncated: false,
    });
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.text()).toContain("src/a.ts");
    expect(wrapper.text()).toContain("src/b.vue");
    await wrapper.findAll(".match-row")[0].trigger("click");
    const viewer = useFileViewer();
    expect(viewer.openAndScrollTo).toHaveBeenCalledWith("/ws/src/a.ts", 1);
  });

  it("api 报错（非法正则）显示错误行", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockRejectedValue("正则无效: ...");
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("(");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.find(".error-line").exists()).toBe(true);
  });

  it("空查询清空结果", async () => {
    vi.useFakeTimers();
    (api.searchInFiles as any).mockResolvedValue({ files: [group("a.ts")], total: 1, truncated: false });
    const wrapper = mount(SearchPanel, { props: { workspacePath: "/ws" } });
    await wrapper.find("input.search-input").setValue("foo");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.text()).toContain("a.ts");
    await wrapper.find("input.search-input").setValue("");
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(wrapper.text()).not.toContain("a.ts");
  });
});
