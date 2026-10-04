import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  viewerOpen: vi.fn(),
  viewerOpenAndScrollTo: vi.fn(),
  fileExists: vi.fn(),
  findFilesByName: vi.fn(),
  fileOpen: vi.fn(),
  openHtml: vi.fn(),
  openInBrowser: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    fileExists: mocks.fileExists,
    findFilesByName: mocks.findFilesByName,
    fileOpen: mocks.fileOpen,
  },
}));

vi.mock("./useRightPanel", () => ({ useRightPanel: () => ({ openInBrowser: mocks.openInBrowser }) }));
vi.mock("./useOpenHtml", () => ({ openHtmlInBuiltinBrowser: mocks.openHtml }));

vi.mock("./useFileViewer", () => ({
  useFileViewer: () => ({
    open: mocks.viewerOpen,
    openAndScrollTo: mocks.viewerOpenAndScrollTo,
  }),
}));

import { useFileResolver } from "./useFileResolver";

describe("useFileResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const r = useFileResolver();
    r.cancelPicker();
    mocks.fileExists.mockResolvedValue(true);
    mocks.findFilesByName.mockResolvedValue([]);
    mocks.fileOpen.mockResolvedValue(undefined);
  });

  it("普通文件仍在 Aide 文件窗口中打开", async () => {
    const r = useFileResolver();
    await r.openResolved("src/App.vue", "C:/repo", 12);

    expect(mocks.viewerOpenAndScrollTo).toHaveBeenCalledWith("C:/repo/src/App.vue", 12, undefined);
    expect(mocks.fileOpen).not.toHaveBeenCalled();
  });

  it("openResolved 透传 flashCount 到 openAndScrollTo（整块高亮行数）", async () => {
    const r = useFileResolver();
    await r.openResolved("src/App.vue", "C:/repo", 12, 5);
    expect(mocks.viewerOpenAndScrollTo).toHaveBeenCalledWith("C:/repo/src/App.vue", 12, 5);
  });

  it("聊天中的 HTML 文件路径在内置浏览器中打开", async () => {
    const r = useFileResolver();
    await r.openResolved("docs/report.html", "C:/repo", 8);

    expect(mocks.openHtml).toHaveBeenCalledWith("C:/repo/docs/report.html");
    expect(mocks.fileOpen).not.toHaveBeenCalled();
    expect(mocks.viewerOpen).not.toHaveBeenCalled();
    expect(mocks.viewerOpenAndScrollTo).not.toHaveBeenCalled();
  });

  it("搜索补全后的 HTML 候选也在内置浏览器中打开", async () => {
    mocks.fileExists.mockResolvedValue(false);
    mocks.findFilesByName.mockResolvedValue(["C:/repo/nested/report.htm"]);
    const r = useFileResolver();

    await r.openResolved("report.htm", "C:/repo");

    expect(mocks.findFilesByName).toHaveBeenCalledWith("report.htm", "C:/repo", 50);
    expect(mocks.openHtml).toHaveBeenCalledWith("C:/repo/nested/report.htm");
    expect(mocks.fileOpen).not.toHaveBeenCalled();
    expect(mocks.viewerOpen).not.toHaveBeenCalled();
  });

  it("HTML URI 不会被拼到工作区路径下", async () => {
    const r = useFileResolver();
    await r.openResolved("file:///C:/repo/report.html", "C:/repo");

    expect(mocks.openHtml).toHaveBeenCalledWith("file:///C:/repo/report.html");
    expect(mocks.viewerOpen).not.toHaveBeenCalled();
  });

  it("http/https 网页链接直接在内置浏览器打开，不做文件探测", async () => {
    const r = useFileResolver();
    await r.openResolved("https://blog.csdn.net/chang100111/article/details/159617774", "C:/repo");

    expect(mocks.openInBrowser).toHaveBeenCalledWith("https://blog.csdn.net/chang100111/article/details/159617774");
    expect(mocks.fileOpen).not.toHaveBeenCalled();
    expect(mocks.openHtml).not.toHaveBeenCalled();
    expect(mocks.fileExists).not.toHaveBeenCalled();
    expect(mocks.findFilesByName).not.toHaveBeenCalled();
    expect(mocks.viewerOpen).not.toHaveBeenCalled();
  });
});
