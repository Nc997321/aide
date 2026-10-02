// @vitest-environment jsdom
// jsdom：useFileViewer 间接 import useSettings
// （模块级 watch 写 document.documentElement 的 CSS 变量），node 环境没有 document。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aide/sdk/api", () => ({
  api: {
    readFileContent: vi.fn(async (path: string) => `content of ${path}`),
    readFileBinary: vi.fn(async () => new ArrayBuffer(0)),
    writeFileContent: vi.fn(async () => undefined),
    lspDidSave: vi.fn(async () => undefined),
    getProjectInfo: vi.fn(async () => ({ root: "C:/proj" })),
    isWorkspaceTrusted: vi.fn(async () => true),
    loadNotifications: vi.fn(async () => []),
    saveNotifications: vi.fn(async () => undefined),
  },
}));
vi.mock("./useRecent", () => ({
  useRecent: () => ({ recordFile: vi.fn(async () => undefined) }),
}));

import { useFileViewer, isWindowDirty, windowDiffOfPair } from "./useFileViewer";
import { api } from "../api";
import type { DiffPair } from "../types";

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

  it("diff 载荷窗口：只读虚拟窗，同路径换载荷就地刷新（不新开）", async () => {
    const v = useFileViewer();
    const pair: DiffPair = {
      oldText: "old",
      newText: "new",
      oldLabel: "修改前",
      newLabel: "修改后",
      status: "modified",
      isBinary: false,
      eolOnly: false,
      tooBig: false,
    };
    await v.open("src/a.ts", { diff: windowDiffOfPair(pair) });
    expect(v.windows.value[0].readonly).toBe(true);
    expect(v.windows.value[0].virtual).toBe(true);
    expect(v.windows.value[0].diff?.parts).toHaveLength(1);

    // 同一文件从累计视图（单段）切到本轮片段（多段）→ 原窗口就地刷新
    await v.open("src/a.ts", { diff: { parts: [{ pair }, { pair }], note: "本轮片段" } });
    expect(v.windows.value).toHaveLength(1);
    expect(v.windows.value[0].diff?.parts).toHaveLength(2);
    expect(v.windows.value[0].diff?.note).toBe("本轮片段");

    // diff 窗与真实文件窗是两扇窗（virtual 区分）——diff 窗里「打开文件并定位」靠它并存
    await v.open("src/a.ts");
    expect(v.windows.value).toHaveLength(2);
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

  it("save 写盘并通知 LSP didSave", async () => {
    const v = useFileViewer();
    await v.open("proj/A.ts");
    // detectProjectRoot 是 fire-and-forget；等它把 projectRoot 置好
    await vi.waitFor(() => expect(v.projectRoot.value).toBe("C:/proj"));
    const win = v.windows.value.find((w) => w.filePath === "proj/A.ts")!;
    win.editContent = "changed";
    await v.save(win.id);
    expect(api.writeFileContent).toHaveBeenCalledWith("proj/A.ts", "changed");
    expect(api.lspDidSave).toHaveBeenCalledWith("C:/proj", "proj/A.ts");
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
