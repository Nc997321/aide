// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const { currentMock, targetsMock, openWindowMock, switchWindowMock } = vi.hoisted(() => ({
  currentMock: vi.fn(),
  targetsMock: vi.fn(),
  openWindowMock: vi.fn(),
  switchWindowMock: vi.fn(),
}));

vi.mock("@aide/sdk", () => ({
  hostApi: { current: currentMock, openWindow: openWindowMock, switchWindow: switchWindowMock },
  remoteWorkspaceApi: { targets: targetsMock },
}));

import OpenFolderDialog from "./OpenFolderDialog.vue";

const local = { key: "local", label: "本机", os: "linux", home: "/home/u" };
const wsl = { key: "wsl:Debian", label: "WSL: Debian", os: "linux", home: "/home/d" };

async function mountIt(host = local) {
  currentMock.mockResolvedValue(host);
  const w = mount(OpenFolderDialog, {
    props: { visible: true },
    attachTo: document.body,
    global: { stubs: { DirTreePicker: true } },
  });
  await flushPromises();
  return w;
}
// 对话框经 Teleport 挂 body：一律从 document 查
const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const text = (sel: string) => q(sel)?.textContent?.trim();
const machineBtn = (label: string) =>
  Array.from(document.body.querySelectorAll<HTMLElement>(".of-machine")).find((b) => b.textContent?.trim() === label)!;
async function click(el: HTMLElement | null) {
  el!.click();
  await flushPromises();
}

describe("OpenFolderDialog：别的 Host 的两条路", () => {
  beforeEach(() => {
    targetsMock.mockReset().mockResolvedValue({ wsl: ["Debian"], ssh: [] });
    openWindowMock.mockReset().mockResolvedValue("host-wsl_Debian");
    switchWindowMock.mockReset().mockResolvedValue(undefined);
    document.body.innerHTML = "";
  });

  it("选本窗口自己的 Host：只有「打开并切换」，没有「在此窗口中打开」", async () => {
    const w = await mountIt();
    expect(q('[data-testid="of-open-here"]')).toBeNull();
    expect(text('[data-testid="of-open-confirm"]')).toBe("打开并切换");
    w.unmount();
  });

  it("选另一台 Host：并排两个按钮；「在新窗口中打开」开它的窗口", async () => {
    const w = await mountIt();
    await click(machineBtn("WSL: Debian"));
    expect(text('[data-testid="of-open-here"]')).toBe("在此窗口中打开");
    expect(text('[data-testid="of-open-confirm"]')).toBe("在新窗口中打开");
    await click(q('[data-testid="of-open-confirm"]'));
    expect(openWindowMock).toHaveBeenCalledWith("wsl:Debian");
    expect(switchWindowMock).not.toHaveBeenCalled();
    expect(w.emitted("update:visible")?.at(-1)).toEqual([false]);
    w.unmount();
  });

  it("「在此窗口中打开」把本窗口换成它，不另开窗口", async () => {
    const w = await mountIt();
    await click(machineBtn("WSL: Debian"));
    await click(q('[data-testid="of-open-here"]'));
    expect(switchWindowMock).toHaveBeenCalledWith("wsl:Debian");
    expect(openWindowMock).not.toHaveBeenCalled();
    w.unmount();
  });

  it("切换失败如实显示，对话框不关", async () => {
    switchWindowMock.mockRejectedValue("本窗口已经连着这台 Host");
    const w = await mountIt();
    await click(machineBtn("WSL: Debian"));
    await click(q('[data-testid="of-open-here"]'));
    expect(text(".of-error")).toContain("已经连着");
    expect(w.emitted("update:visible")).toBeUndefined();
    w.unmount();
  });

  it("没有主窗口：远程窗口里「本机」也是一台别的 Host，可换回", async () => {
    const w = await mountIt(wsl);
    const labels = Array.from(document.body.querySelectorAll(".of-machine")).map((b) => b.textContent?.trim());
    expect(labels).toContain("本机");
    await click(machineBtn("本机"));
    await click(q('[data-testid="of-open-here"]'));
    expect(switchWindowMock).toHaveBeenCalledWith("local");
    w.unmount();
  });
});
