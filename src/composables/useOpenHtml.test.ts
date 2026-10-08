import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fileGuiPath: vi.fn(),
  openInBrowser: vi.fn(),
  push: vi.fn(),
}));

vi.mock("../api", () => ({ api: { fileGuiPath: mocks.fileGuiPath } }));
vi.mock("./useRightPanel", () => ({ useRightPanel: () => ({ openInBrowser: mocks.openInBrowser }) }));
vi.mock("./useNotifications", () => ({ useNotifications: () => ({ push: mocks.push }) }));

import { openHtmlInBuiltinBrowser } from "./useOpenHtml";

describe("openHtmlInBuiltinBrowser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("本机路径 → file:// URL 交给右栏浏览器", async () => {
    mocks.fileGuiPath.mockResolvedValue("C:\\repo\\docs\\report.html");
    await openHtmlInBuiltinBrowser("C:\\repo\\docs\\report.html");
    expect(mocks.openInBrowser).toHaveBeenCalledWith("file:///C:/repo/docs/report.html");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("WSL Host 的路径经翻译后以 UNC file URL 打开", async () => {
    mocks.fileGuiPath.mockResolvedValue("\\\\wsl.localhost\\Debian\\home\\me\\a.html");
    await openHtmlInBuiltinBrowser("/home/me/a.html");
    expect(mocks.openInBrowser).toHaveBeenCalledWith("file://wsl.localhost/Debian/home/me/a.html");
  });

  it("SSH Host 拒绝跨界 → 出声通知，不打开", async () => {
    mocks.fileGuiPath.mockRejectedValue("prod 上的文件无法在本机打开");
    await openHtmlInBuiltinBrowser("/srv/a.html");
    expect(mocks.openInBrowser).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith(expect.objectContaining({ severity: "error" }));
  });
});
