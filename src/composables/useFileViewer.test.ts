import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api", () => ({
  api: {
    readFileContent: vi.fn(async (path: string) => `content of ${path}`),
    readFileBinary: vi.fn(async () => new ArrayBuffer(0)),
    writeFileContent: vi.fn(async () => undefined),
    getProjectInfo: vi.fn(async () => ({ root: "C:/proj" })),
  },
}));
vi.mock("./useRecent", () => ({
  useRecent: () => ({ recordFile: vi.fn(async () => undefined) }),
}));

import { useFileViewer, isWindowDirty } from "./useFileViewer";
import { api } from "../api";

describe("useFileViewer 多窗口 store", () => {
  beforeEach(() => {
    useFileViewer().__resetForTest();
    vi.clearAllMocks();
  });

  it("打开文件默认可编辑（非只读），markdown 默认分屏", async () => {
    const v = useFileViewer();
    await v.open("src/App.vue");
    await v.open("README.md");
    expect(v.windows.value).toHaveLength(2);
    const [code, md] = v.windows.value;
    expect(code.readonly).toBe(false);
    expect(code.editContent).toBe("content of src/App.vue");
    expect(md.isMarkdown).toBe(true);
    expect(md.mdMode).toBe("split");
  });

  it("同一路径重复打开不产生副本，而是聚焦已有窗口", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    await v.open("b.ts");
    expect(v.focusedId.value).toBeNull(); // 新开窗口回平铺全览
    await v.open("a.ts");
    expect(v.windows.value).toHaveLength(2);
    expect(v.focusedId.value).toBe(v.windows.value[0].id);
  });

  it("注入内容的虚拟视图（git diff）只读，同路径重开就地刷新", async () => {
    const v = useFileViewer();
    await v.open("src/a.ts", { content: "diff v1", language: "diff" });
    expect(v.windows.value[0].readonly).toBe(true);
    expect(v.windows.value[0].virtual).toBe(true);
    await v.open("src/a.ts", { content: "diff v2", language: "diff" });
    expect(v.windows.value).toHaveLength(1);
    expect(v.windows.value[0].content).toBe("diff v2");
  });

  it("dirty 判定与保存：编辑内容偏离基线为脏，保存后回到干净", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    const win = v.windows.value[0];
    expect(isWindowDirty(win)).toBe(false);
    win.editContent = "changed";
    expect(isWindowDirty(win)).toBe(true);
    await v.save(win.id);
    expect(api.writeFileContent).toHaveBeenCalledWith("a.ts", "changed");
    expect(isWindowDirty(win)).toBe(false);
  });

  it("关闭聚焦窗口后回到平铺全览", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    await v.open("b.ts");
    const first = v.windows.value[0];
    v.focusWindow(first.id);
    expect(v.focusedId.value).toBe(first.id);
    v.closeWindow(first.id);
    expect(v.windows.value).toHaveLength(1);
    expect(v.focusedId.value).toBeNull();
  });

  it("openAndScrollTo 聚焦目标窗口并挂上待滚动行号", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    await v.openAndScrollTo("b.ts", 42);
    const target = v.windows.value.find((w) => w.filePath === "b.ts")!;
    expect(target.scrollToLine).toBe(42);
    expect(v.focusedId.value).toBe(target.id);
  });

  it("超过 1MB 的大文件只读", async () => {
    vi.mocked(api.readFileContent).mockResolvedValueOnce("x".repeat(1_000_001));
    const v = useFileViewer();
    await v.open("big.ts");
    expect(v.windows.value[0].readonly).toBe(true);
  });
});
