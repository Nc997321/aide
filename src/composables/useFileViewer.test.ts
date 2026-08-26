// @vitest-environment jsdom
// jsdom：useFileViewer 经 useCodeGraphProgress 门面间接 import useSettings
// （模块级 watch 写 document.documentElement 的 CSS 变量），node 环境没有 document。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api", () => ({
  api: {
    readFileContent: vi.fn(async (path: string) => `content of ${path}`),
    readFileBinary: vi.fn(async () => new ArrayBuffer(0)),
    writeFileContent: vi.fn(async () => undefined),
    getProjectInfo: vi.fn(async () => ({ root: "C:/proj" })),
    isWorkspaceTrusted: vi.fn(async () => true),
    codegraphBuildIndex: vi.fn(async () => undefined),
    codegraphClose: vi.fn(async () => undefined),
    codegraphReindexFile: vi.fn(async () => undefined),
    codegraphBuildProgress: vi.fn(async () => ({ active: false, done: 0, total: 0, current: "", index_ready: false })),
    loadNotifications: vi.fn(async () => []),
    saveNotifications: vi.fn(async () => undefined),
  },
}));
vi.mock("./useRecent", () => ({
  useRecent: () => ({ recordFile: vi.fn(async () => undefined) }),
}));

import { useFileViewer, isWindowDirty } from "./useFileViewer";
import { useNotifications } from "./useNotifications";
import { api } from "../api";

describe("useFileViewer 多窗口 store", () => {
  beforeEach(() => {
    useFileViewer().__resetForTest();
    vi.clearAllMocks();
  });

  it("打开文件默认可编辑（非只读），markdown 默认全预览", async () => {
    const v = useFileViewer();
    await v.open("src/App.vue");
    await v.open("README.md");
    expect(v.windows.value).toHaveLength(2);
    const [code, md] = v.windows.value;
    expect(code.readonly).toBe(false);
    expect(code.editContent).toBe("content of src/App.vue");
    expect(md.isMarkdown).toBe(true);
    expect(md.mdMode).toBe("preview");
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

  it("openAndScrollTo 透传 flashCount 到 win（整块高亮行数）", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    await v.openAndScrollTo("a.ts", 10, 5);
    const target = v.windows.value.find((w) => w.filePath === "a.ts")!;
    expect(target.scrollToLine).toBe(10);
    expect(target.flashCount).toBe(5);
  });

  it("openAndScrollTo 不传 flashCount 时 win.flashCount 为 null（单行高亮）", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    await v.openAndScrollTo("a.ts", 10);
    const target = v.windows.value.find((w) => w.filePath === "a.ts")!;
    expect(target.flashCount).toBeNull();
  });

  it("超过 1MB 的大文件只读", async () => {
    vi.mocked(api.readFileContent).mockResolvedValueOnce("x".repeat(1_000_001));
    const v = useFileViewer();
    await v.open("big.ts");
    expect(v.windows.value[0].readonly).toBe(true);
  });

  it("save 触发该文件的 codegraph 增量 reindex", async () => {
    const v = useFileViewer();
    await v.open("proj/A.ts");
    // detectProjectRoot 是 fire-and-forget；等它把 projectRoot 置好
    await vi.waitFor(() => expect(v.projectRoot.value).toBe("C:/proj"));
    const win = v.windows.value.find((w) => w.filePath === "proj/A.ts")!;
    win.editContent = "changed";
    await v.save(win.id);
    expect(api.writeFileContent).toHaveBeenCalledWith("proj/A.ts", "changed");
    expect(api.codegraphReindexFile).toHaveBeenCalledWith("C:/proj", "proj/A.ts");
  });

  it("save reindex 成功时在对应窗口闪现「索引已更新」提示（不进通知中心）", async () => {
    vi.mocked(api.codegraphReindexFile).mockResolvedValueOnce({ reindexed: true });
    const { notifications } = useNotifications();
    const before = notifications.value.filter((n) => n.source === "codegraph").length;
    const v = useFileViewer();
    await v.open("proj/A.ts");
    await vi.waitFor(() => expect(v.projectRoot.value).toBe("C:/proj"));
    const win = v.windows.value.find((w) => w.filePath === "proj/A.ts")!;
    win.editContent = "changed";
    await v.save(win.id);
    // reindex 是 fire-and-forget；等 .then 把提示挂上
    await vi.waitFor(() => expect(v.indexHintWinId.value).toBe(win.id));
    // 成功是常态，不进通知中心：codegraph 通知数量不应增长
    expect(notifications.value.filter((n) => n.source === "codegraph").length).toBe(before);
  });

  it("save reindex 返回 embed_not_ready 时进通知中心（warning），不闪现提示", async () => {
    vi.mocked(api.codegraphReindexFile).mockResolvedValueOnce({
      reindexed: false,
      skipped: "embed_not_ready",
    });
    const { notifications } = useNotifications();
    const v = useFileViewer();
    await v.open("proj/B.ts");
    await vi.waitFor(() => expect(v.projectRoot.value).toBe("C:/proj"));
    const win = v.windows.value.find((w) => w.filePath === "proj/B.ts")!;
    win.editContent = "changed";
    await v.save(win.id);
    await vi.waitFor(() => {
      const n = notifications.value.find(
        (x) => x.source === "codegraph" && x.dedupKey?.startsWith("codegraph:save:embed_not_ready:"),
      );
      expect(n).toBeTruthy();
      expect(n!.severity).toBe("warning");
    });
    // embed_not_ready 不算成功，不闪现提示
    expect(v.indexHintWinId.value).toBeNull();
  });

  it("切换 project root 触发重建并关闭上一个索引", async () => {
    vi.mocked(api.getProjectInfo).mockImplementation(async () => ({ root: "proj/one", name: "one", branch: "main" }));
    const v = useFileViewer();
    await v.open("proj/one/A.ts");
    await vi.waitFor(() =>
      expect(api.codegraphBuildIndex).toHaveBeenCalledWith("proj/one"),
    );

    vi.mocked(api.getProjectInfo).mockImplementation(async () => ({ root: "proj/two", name: "two", branch: "main" }));
    await v.open("proj/two/B.ts");
    await vi.waitFor(() => {
      expect(api.codegraphClose).toHaveBeenCalledWith("proj/one");
      expect(api.codegraphBuildIndex).toHaveBeenCalledWith("proj/two");
    });
  });

  // ── 窗口内导航栈（跳转定义/引用就地覆盖 + 后退）──

  it("navigateInPlace 把目标文件灌进同一窗口并压栈（不新开窗口）", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    const win = v.windows.value[0];
    await v.navigateInPlace(win.id, "b.ts", { line: 42, sourceLine: 7, viewportY: 120 });
    expect(v.windows.value).toHaveLength(1); // 没有新窗口
    expect(win.filePath).toBe("b.ts");
    expect(win.fileName).toBe("b.ts");
    expect(win.editContent).toBe("content of b.ts");
    expect(win.scrollToLine).toBe(42);
    expect(win.scrollViewportY).toBe(120);
    expect(win.navStack).toHaveLength(1);
    expect(win.navStack[0]).toMatchObject({
      filePath: "a.ts",
      editContent: "content of a.ts",
      content: "content of a.ts",
      line: 7,
      viewportY: 120,
    });
  });

  it("navigateBack 弹栈恢复上一个文件与滚动落点", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    const win = v.windows.value[0];
    await v.navigateInPlace(win.id, "b.ts", { line: 42, sourceLine: 7, viewportY: 120 });
    await v.navigateBack(win.id);
    expect(win.filePath).toBe("a.ts");
    expect(win.editContent).toBe("content of a.ts");
    expect(win.scrollToLine).toBe(7);
    // 回退时 viewportY 随栈恢复——源行定位到该偏移处复刻跳转前滚动位置
    expect(win.scrollViewportY).toBe(120);
    expect(win.navStack).toHaveLength(0);
    expect(isWindowDirty(win)).toBe(false);
  });

  it("脏文件压栈后后退，未保存修改原样恢复（dirty 复现）", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    const win = v.windows.value[0];
    win.editContent = "unsaved changes";
    await v.navigateInPlace(win.id, "b.ts", { line: 1, sourceLine: 3, viewportY: null });
    expect(isWindowDirty(win)).toBe(false); // b.ts 是干净的新加载
    await v.navigateBack(win.id);
    expect(win.editContent).toBe("unsaved changes");
    expect(win.content).toBe("content of a.ts");
    expect(isWindowDirty(win)).toBe(true);
  });

  it("同文件内跳转也压栈，后退回原行", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    const win = v.windows.value[0];
    await v.navigateInPlace(win.id, "a.ts", { line: 200, sourceLine: 10, viewportY: null });
    expect(v.windows.value).toHaveLength(1);
    expect(win.filePath).toBe("a.ts");
    expect(win.scrollToLine).toBe(200);
    expect(win.navStack).toHaveLength(1);
    await v.navigateBack(win.id);
    expect(win.filePath).toBe("a.ts");
    expect(win.scrollToLine).toBe(10);
    expect(win.navStack).toHaveLength(0);
  });

  it("目标已在另一窗口打开时退化为聚焦该窗口，本窗口内容与栈不变", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    await v.open("b.ts");
    const [wa, wb] = v.windows.value;
    await v.navigateInPlace(wa.id, "b.ts", { line: 42, sourceLine: 7, viewportY: null });
    expect(wa.filePath).toBe("a.ts");
    expect(wa.navStack).toHaveLength(0);
    expect(v.focusedId.value).toBe(wb.id);
    expect(wb.scrollToLine).toBe(42);
  });

  it("目标读取失败：窗口显示错误、栈保留、后退可恢复原文件", async () => {
    vi.mocked(api.readFileContent).mockImplementation(async (path: string) => {
      if (path === "bad.ts") throw new Error("read failed");
      return `content of ${path}`;
    });
    const v = useFileViewer();
    await v.open("a.ts");
    const win = v.windows.value[0];
    await v.navigateInPlace(win.id, "bad.ts", { line: 1, sourceLine: 5, viewportY: null });
    expect(win.error).toBeTruthy();
    expect(win.navStack).toHaveLength(1);
    await v.navigateBack(win.id);
    expect(win.filePath).toBe("a.ts");
    expect(win.error).toBe("");
    expect(win.editContent).toBe("content of a.ts");
    expect(win.navStack).toHaveLength(0);
  });

  it("markdown 窗口的 mdMode 随栈恢复", async () => {
    const v = useFileViewer();
    await v.open("README.md");
    const win = v.windows.value[0];
    win.mdMode = "edit";
    await v.navigateInPlace(win.id, "a.ts", { line: 1, sourceLine: null, viewportY: null });
    expect(win.isMarkdown).toBe(false);
    await v.navigateBack(win.id);
    expect(win.isMarkdown).toBe(true);
    expect(win.mdMode).toBe("edit");
  });

  it("navStackHasDirty 只在栈内有未保存修改时为真", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    const win = v.windows.value[0];
    expect(v.navStackHasDirty(win)).toBe(false);
    // 干净压栈 → 仍 false
    await v.navigateInPlace(win.id, "b.ts", { line: 1, sourceLine: 1, viewportY: null });
    expect(v.navStackHasDirty(win)).toBe(false);
    // b.ts 改脏再压栈 → true
    win.editContent = "dirty b";
    await v.navigateInPlace(win.id, "c.ts", { line: 1, sourceLine: 1, viewportY: null });
    expect(v.navStackHasDirty(win)).toBe(true);
    // 弹掉脏 entry → false
    await v.navigateBack(win.id);
    expect(v.navStackHasDirty(win)).toBe(false);
  });

  it("栈空时 navigateBack 是 no-op", async () => {
    const v = useFileViewer();
    await v.open("a.ts");
    const win = v.windows.value[0];
    await v.navigateBack(win.id);
    expect(win.filePath).toBe("a.ts");
    expect(win.editContent).toBe("content of a.ts");
  });
});
