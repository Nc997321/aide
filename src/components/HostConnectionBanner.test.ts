// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const { identityMock, statusesMock, connectMock, handlers } = vi.hoisted(() => ({
  identityMock: vi.fn(),
  statusesMock: vi.fn(),
  connectMock: vi.fn(),
  handlers: [] as Array<(e: { payload: unknown }) => void>,
}));

vi.mock("@aide/sdk", () => ({
  hostApi: { identity: identityMock },
  remoteWorkspaceApi: { statuses: statusesMock, connect: connectMock },
  REMOTE_WORKSPACE_STATUS_EVENT: "remote-workspace-status",
  listen: vi.fn(async (_ev: string, cb: (e: { payload: unknown }) => void) => {
    handlers.push(cb);
    return () => {};
  }),
}));

import HostConnectionBanner from "./HostConnectionBanner.vue";

const ssh = { key: "ssh:devbox", label: "SSH: devbox" };
const status = (state: string, detail?: string) => ({ host: "ssh:devbox", label: "SSH: devbox", state, detail });

async function mountBanner() {
  const w = mount(HostConnectionBanner);
  await flushPromises();
  return w;
}

describe("HostConnectionBanner", () => {
  beforeEach(() => {
    handlers.length = 0;
    identityMock.mockReset().mockResolvedValue(ssh);
    statusesMock.mockReset().mockResolvedValue([]);
    connectMock.mockReset();
  });

  it("本机窗口恒不显示，也不订阅状态事件", async () => {
    identityMock.mockResolvedValue({ key: "local", label: "本机" });
    const w = await mountBanner();
    expect(w.find(".host-banner").exists()).toBe(false);
    expect(handlers).toHaveLength(0);
  });

  it("连接正常时不显示；断开事件到达后显示原因与重新连接按钮", async () => {
    const w = await mountBanner();
    handlers[0]({ payload: status("connected") });
    await flushPromises();
    expect(w.find(".host-banner").exists()).toBe(false);

    handlers[0]({ payload: status("disconnected", "与 SSH: devbox 的连接已断开：broken pipe") });
    await flushPromises();
    expect(w.find(".host-banner").exists()).toBe(true);
    expect(w.text()).toContain("broken pipe");
    expect(w.find("button").text()).toBe("重新连接");
  });

  it("自动重连中：只提示会话仍在、没有按钮；连回来后条自己消失", async () => {
    const w = await mountBanner();
    handlers[0]({ payload: status("reconnecting", "ssh: broken pipe") });
    await flushPromises();
    expect(w.find(".host-banner").exists()).toBe(true);
    expect(w.text()).toContain("自动重新连接");
    expect(w.text()).toContain("会话仍在运行");
    expect(w.find("button").exists()).toBe(false);

    handlers[0]({ payload: status("connected") });
    await flushPromises();
    expect(w.find(".host-banner").exists()).toBe(false);
  });

  it("重连上了但错过的更新补不齐：提示会话仍在，按钮是「重新加载」", async () => {
    const w = await mountBanner();
    handlers[0]({ payload: status("resync", "断线期间错过的更新太多") });
    await flushPromises();
    expect(w.text()).toContain("错过了部分更新");
    expect(w.text()).not.toContain("会话已终止");
    expect(w.find("button").text()).toBe("重新加载");
  });

  it("建连中：说清在等什么（安装步骤原样带出），没有按钮；连上后条自己消失", async () => {
    statusesMock.mockResolvedValue([status("installing")]);
    const w = await mountBanner();
    expect(w.text()).toContain("正在连接 SSH: devbox");
    expect(w.find("button").exists()).toBe(false);

    // 量不出来的步骤：流动条，不报百分比
    expect(w.find(".host-banner-bar").classes()).toContain("indeterminate");
    expect(w.find(".host-banner-percent").exists()).toBe(false);

    // 下载：带进度
    handlers[0]({ payload: { ...status("installing", "正在下载 Claude CLI（37 / 107 MB）"), progress: 0.346 } });
    await flushPromises();
    expect(w.text()).toContain("正在下载 Claude CLI（37 / 107 MB）");
    expect(w.find(".host-banner-percent").text()).toBe("35%");
    expect(w.find(".host-banner-bar").classes()).not.toContain("indeterminate");
    expect(w.find(".host-banner-bar").attributes("aria-valuenow")).toBe("35");
    expect(w.find(".host-banner-bar-fill").attributes("style")).toContain("width: 35%");

    handlers[0]({ payload: status("connecting") });
    await flushPromises();
    expect(w.find(".host-banner").exists()).toBe(true);

    handlers[0]({ payload: status("connected") });
    await flushPromises();
    expect(w.find(".host-banner").exists()).toBe(false);
  });

  it("没连上：给原因和重新连接，不说「会话已终止」（根本没连上过）", async () => {
    const w = await mountBanner();
    handlers[0]({ payload: status("error", "WSL: Debian 握手超时") });
    await flushPromises();
    expect(w.text()).toContain("无法连接 SSH: devbox");
    expect(w.text()).toContain("握手超时");
    expect(w.text()).not.toContain("会话已终止");
    expect(w.find("button").text()).toBe("重新连接");
  });

  it("只认本窗口 Host 的状态，别的 Host 的断开不影响", async () => {
    const w = await mountBanner();
    handlers[0]({ payload: { ...status("disconnected"), host: "wsl:Debian", label: "WSL: Debian" } });
    await flushPromises();
    expect(w.find(".host-banner").exists()).toBe(false);
  });

  it("窗口晚于断开才挂上：补读到的当前状态也要显示", async () => {
    statusesMock.mockResolvedValue([status("disconnected", "gone")]);
    const w = await mountBanner();
    expect(w.find(".host-banner").exists()).toBe(true);
  });

  it("重新连接失败：留在条上显示失败原因，可再试", async () => {
    statusesMock.mockResolvedValue([status("disconnected", "gone")]);
    connectMock.mockRejectedValue("ssh: connect timed out");
    const w = await mountBanner();
    await w.find("button").trigger("click");
    await flushPromises();
    expect(connectMock).toHaveBeenCalledWith("ssh:devbox");
    expect(w.text()).toContain("connect timed out");
    expect(w.find("button").exists()).toBe(true);
  });
});
