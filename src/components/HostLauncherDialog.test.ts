// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const m = vi.hoisted(() => ({
  current: vi.fn(),
  recents: vi.fn(),
  targets: vi.fn(),
  statuses: vi.fn(),
  openWindow: vi.fn(),
  forgetRecent: vi.fn(),
  handlers: [] as Array<(e: { payload: unknown }) => void>,
}));

vi.mock("@aide/sdk", () => ({
  hostApi: {
    current: m.current,
    recents: m.recents,
    openWindow: m.openWindow,
    forgetRecent: m.forgetRecent,
  },
  remoteWorkspaceApi: { targets: m.targets, statuses: m.statuses },
  REMOTE_WORKSPACE_STATUS_EVENT: "remote-workspace-status",
  listen: vi.fn(async (_e: string, cb: (e: { payload: unknown }) => void) => {
    m.handlers.push(cb);
    return () => {};
  }),
}));

import HostLauncherDialog from "./HostLauncherDialog.vue";

const local = { key: "local", label: "本机", os: "windows", home: "C:\\Users\\u" };

async function mountOpen() {
  const w = mount(HostLauncherDialog, {
    props: { visible: true },
    global: { directives: { overlayLayer: {} } },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

const host = (key: string) => document.body.querySelector<HTMLElement>(`[data-host="${key}"]`);

describe("HostLauncherDialog", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    m.handlers.length = 0;
    m.current.mockReset().mockResolvedValue(local);
    m.recents.mockReset().mockResolvedValue([]);
    m.targets.mockReset().mockResolvedValue({ wsl: [], ssh: [] });
    m.statuses.mockReset().mockResolvedValue([]);
    m.openWindow.mockReset().mockResolvedValue("host-x");
    m.forgetRecent.mockReset().mockResolvedValue(undefined);
  });

  it("本机恒在最前；WSL / SSH 目标与「用过但不在清单里」的 Host 都列出，且不重复", async () => {
    m.targets.mockResolvedValue({ wsl: ["Debian"], ssh: ["devbox"] });
    m.recents.mockResolvedValue([
      { host: "ssh:devbox", label: "SSH: devbox", projects: [{ path: "/srv/app", openedAt: 2 }] },
      { host: "ssh:old-box", label: "SSH: old-box", projects: [{ path: "/x", openedAt: 1 }] },
    ]);
    await mountOpen();
    const keys = [...document.body.querySelectorAll<HTMLElement>("[data-host]")].map((e) => e.dataset.host);
    expect(keys).toEqual(["local", "wsl:Debian", "ssh:devbox", "ssh:old-box"]);
  });

  it("点最近项目 = 开那台 Host 的窗口并带上目录；点「打开」= 只开窗口", async () => {
    m.recents.mockResolvedValue([
      { host: "local", label: "本机", projects: [{ path: "C:\\work\\proj", openedAt: 1 }] },
    ]);
    m.targets.mockResolvedValue({ wsl: ["Debian"], ssh: [] });
    await mountOpen();

    host("local")!.querySelector<HTMLButtonElement>(".hl-project-btn")!.click();
    await flushPromises();
    expect(m.openWindow).toHaveBeenCalledWith("local", "C:\\work\\proj");

    document.body.innerHTML = "";
    await mountOpen();
    host("wsl:Debian")!.querySelector<HTMLButtonElement>(".hl-open")!.click();
    await flushPromises();
    expect(m.openWindow).toHaveBeenLastCalledWith("wsl:Debian", undefined);
  });

  it("移除最近项目：调用后端并立刻从列表消失", async () => {
    m.recents.mockResolvedValue([
      { host: "local", label: "本机", projects: [{ path: "/a", openedAt: 2 }, { path: "/b", openedAt: 1 }] },
    ]);
    await mountOpen();
    host("local")!.querySelector<HTMLButtonElement>(".hl-forget")!.click();
    await flushPromises();
    expect(m.forgetRecent).toHaveBeenCalledWith("local", "/a");
    const paths = [...host("local")!.querySelectorAll(".hl-project-path")].map((e) => e.textContent);
    expect(paths).toEqual(["/b"]);
  });

  it("连接状态随事件更新；当前窗口的 Host 有标记", async () => {
    m.current.mockResolvedValue({ key: "wsl:Debian", label: "WSL: Debian", os: "linux", home: "/home/u" });
    m.targets.mockResolvedValue({ wsl: ["Debian"], ssh: [] });
    await mountOpen();
    expect(host("wsl:Debian")!.textContent).toContain("当前窗口");
    expect(host("wsl:Debian")!.querySelector(".hl-badge.connected")).toBeNull();

    m.handlers[0]({ payload: { host: "wsl:Debian", label: "WSL: Debian", state: "connected" } });
    await flushPromises();
    expect(host("wsl:Debian")!.querySelector(".hl-badge.connected")?.textContent).toBe("已连接");
  });

  it("手输 SSH 主机：非法名字（含空格 / 以 - 开头）被拒，不发起连接", async () => {
    const w = await mountOpen();
    document.body.querySelector<HTMLButtonElement>(".hl-link")!.click();
    await flushPromises();
    const input = document.body.querySelector<HTMLInputElement>(".hl-ssh-input input")!;
    for (const bad of ["a b", "-oProxyCommand=x"]) {
      input.value = bad;
      input.dispatchEvent(new Event("input"));
      document.body.querySelector<HTMLButtonElement>(".hl-ssh-input .hl-open")!.click();
      await flushPromises();
      expect(document.body.querySelector(".hl-error")).not.toBeNull();
    }
    expect(m.openWindow).not.toHaveBeenCalled();

    input.value = "me@devbox";
    input.dispatchEvent(new Event("input"));
    document.body.querySelector<HTMLButtonElement>(".hl-ssh-input .hl-open")!.click();
    await flushPromises();
    expect(m.openWindow).toHaveBeenCalledWith("ssh:me@devbox", undefined);
    w.unmount();
  });
});
