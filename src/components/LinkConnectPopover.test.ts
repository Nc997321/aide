// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const { statusMock, setEnabledMock, setRelayUrlMock, createOfferMock, cancelOfferMock, revokeMock, updateMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  setEnabledMock: vi.fn(),
  setRelayUrlMock: vi.fn(),
  createOfferMock: vi.fn(),
  cancelOfferMock: vi.fn(),
  revokeMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock("@aide/sdk", () => ({
  linkApi: {
    status: statusMock,
    setEnabled: setEnabledMock,
    setRelayUrl: setRelayUrlMock,
    createOffer: createOfferMock,
    cancelOffer: cancelOfferMock,
    revoke: revokeMock,
  },
}));

// 权限模式落盘走 useSettings：只断言 update 收到什么（视觉翻转不在本测试范围）
vi.mock("../composables/useSettings", () => ({
  useSettings: () => ({ settings: { remote: { permissionMode: "auto" } }, update: updateMock }),
}));

// AppLogo 顶层 `import iconUrl from "/icon.png"`（public 资源）在 vitest 下解析成 file:///icon.png
// 触发 fs 报错——mock 掉整个模块（与 TitleBar / ChatPanel 测试同款处理）。
vi.mock("./AppLogo.vue", () => ({
  default: { name: "AppLogo", template: '<div class="app-logo-stub"/>' },
}));

import LinkConnectPopover from "./LinkConnectPopover.vue";

const base = {
  enabled: true,
  connected: true,
  relaySuppressed: false,
  lastError: "",
  deviceId: "00112233445566778899aabbccddeeff",
  hostName: "devbox",
  paired: false,
  offerActive: true,
  relayUrl: "wss://relay.example.com",
};
const offer = () => ({
  uri: "aide-link://pair?v=1",
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>',
  expiresAtUnix: Math.floor(Date.now() / 1000) + 600,
});

const tooltip = { mounted() {}, updated() {} };
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const setDraft = async (v: string) => {
  const input = q("link-relay-input") as HTMLInputElement;
  input.value = v;
  input.dispatchEvent(new Event("input"));
  await flushPromises();
};

// 断言失败也要卸载：残留的卡片会串进下一条用例
const mounted: Array<{ unmount: () => void }> = [];

async function openCard() {
  const w = mount(LinkConnectPopover, { attachTo: document.body, global: { directives: { tooltip } } });
  mounted.push(w);
  await w.get('[data-testid="link-connect-btn"]').trigger("click");
  await flushPromises();
  return w;
}

describe("LinkConnectPopover", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    statusMock.mockReset().mockResolvedValue({ ...base });
    setEnabledMock.mockReset().mockImplementation(async (enabled: boolean) => ({ ...base, enabled }));
    setRelayUrlMock.mockReset().mockImplementation(async (url: string) => ({ ...base, relayUrl: url.trim() || null }));
    createOfferMock.mockReset().mockResolvedValue(offer());
    cancelOfferMock.mockReset().mockResolvedValue(undefined);
    revokeMock.mockReset().mockResolvedValue(undefined);
    updateMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const w of mounted.splice(0)) w.unmount();
    document.body.innerHTML = "";
  });

  it("没点开之前不挂卡片：不轮询网关、不生成二维码", async () => {
    const w = mount(LinkConnectPopover, { attachTo: document.body, global: { directives: { tooltip } } });
    mounted.push(w);
    await flushPromises();
    expect(q("link-connect-card")).toBeNull();
    expect(statusMock).not.toHaveBeenCalled();
    expect(createOfferMock).not.toHaveBeenCalled();
  });

  it("点开：已启用且没配对过 → 直接出码，只当 <img> 的 data URL", async () => {
    const w = await openCard();
    expect(createOfferMock).toHaveBeenCalledTimes(1);
    expect(q("link-connect-qr")!.getAttribute("src")).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(document.body.innerHTML).not.toContain("<script");
  });

  it("中继地址：初值 = 生效地址；填新值点「生成」→ 先落盘（立即重连）再出码，并提示重新扫码", async () => {
    await openCard();
    expect((q("link-relay-input") as HTMLInputElement).value).toBe("wss://relay.example.com");
    const before = createOfferMock.mock.calls.length;
    await setDraft("wss://vps.example:8443");
    q("link-relay-generate")!.click();
    await flushPromises();
    expect(setRelayUrlMock).toHaveBeenCalledWith("wss://vps.example:8443");
    expect(createOfferMock.mock.calls.length).toBe(before + 1);
    expect(setRelayUrlMock.mock.invocationCallOrder[0]).toBeLessThan(
      createOfferMock.mock.invocationCallOrder[before],
    );
    expect(q("link-connect-note")!.textContent).toContain("重新扫码");
  });

  it("地址没变就不会白跑一次 setRelayUrl（点生成 = 只出码）", async () => {
    await openCard();
    const before = createOfferMock.mock.calls.length;
    q("link-relay-generate")!.click();
    await flushPromises();
    expect(setRelayUrlMock).not.toHaveBeenCalled();
    expect(createOfferMock.mock.calls.length).toBe(before + 1);
  });

  it("非法地址：前端给提示、禁用生成、不打扰后端", async () => {
    await openCard();
    await setDraft("http://relay.example.com");
    expect(q("link-relay-hint")!.textContent).toContain("ws://");
    expect((q("link-relay-generate") as HTMLButtonElement).disabled).toBe(true);
    expect(setRelayUrlMock).not.toHaveBeenCalled();
  });

  it("清空地址点生成：落盘为空（= 未配置），并提示要填地址", async () => {
    await openCard();
    const before = createOfferMock.mock.calls.length;
    await setDraft("");
    q("link-relay-generate")!.click();
    await flushPromises();
    expect(setRelayUrlMock).toHaveBeenCalledWith("");
    expect(createOfferMock.mock.calls.length).toBe(before); // 没地址不发 createOffer
    expect(q("link-connect-note")!.textContent).toContain("清除");
  });

  it("没配地址（没有出厂默认）：空态提示先填地址，不自动出码", async () => {
    statusMock.mockResolvedValue({ ...base, relayUrl: null, enabled: false, offerActive: false });
    await openCard();
    expect(q("link-connect-empty")!.textContent).toContain("请先填写中继地址");
    expect(createOfferMock).not.toHaveBeenCalled();
    expect((q("link-relay-input") as HTMLInputElement).value).toBe("");
  });

  it("权限模式：分段控件改档 → 落盘 settings.remote.permissionMode", async () => {
    await openCard();
    const seg = q("link-permission-mode")!;
    const buttons = Array.from(seg.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent === "自动")!.getAttribute("aria-pressed")).toBe("true");
    buttons.find((b) => b.textContent === "手动")!.click();
    await flushPromises();
    expect(updateMock).toHaveBeenCalledWith({ remote: { permissionMode: "manual" } });
  });

  it("已配对：不自动出码（配对新手机会顶掉旧的），要用户明确点「配对新手机」", async () => {
    statusMock.mockResolvedValue({ ...base, paired: true, offerActive: false });
    const w = await openCard();
    expect(createOfferMock).not.toHaveBeenCalled();
    expect(q("link-connect-qr")).toBeNull();
    q("link-connect-repair")!.click();
    await flushPromises();
    expect(createOfferMock).toHaveBeenCalledTimes(1);
  });

  it("未启用：开关打开后启用并出码", async () => {
    statusMock.mockResolvedValue({ ...base, enabled: false, offerActive: false });
    const w = await openCard();
    expect(createOfferMock).not.toHaveBeenCalled();
    expect(q("link-connect-empty")!.textContent).toContain("开启");
    const toggle = q("link-connect-toggle") as HTMLInputElement;
    toggle.checked = true;
    statusMock.mockResolvedValue({ ...base }); // 启用后 Host 上二维码是有效的
    toggle.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(setEnabledMock).toHaveBeenCalledWith(true);
    expect(createOfferMock).toHaveBeenCalledTimes(1);
    expect(q("link-connect-qr")).not.toBeNull();
  });

  it("点卡片外面 / Esc 收起，并撤掉还开着的一次性密钥", async () => {
    const w = await openCard();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(q("link-connect-card")).toBeNull();
    expect(cancelOfferMock).toHaveBeenCalledTimes(1);

    await w.get('[data-testid="link-connect-btn"]').trigger("click");
    await flushPromises();
    expect(q("link-connect-card")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(q("link-connect-card")).toBeNull();
    expect(cancelOfferMock).toHaveBeenCalledTimes(2);
  });

  it("二维码中心压着 logo；正常时不露状态行，也没有「关闭二维码」按钮", async () => {
    await openCard();
    expect(q("link-connect-card")!.querySelector(".lc-logo")).not.toBeNull();
    expect(q("link-connect-state")).toBeNull();
    expect(q("link-connect-cancel")).toBeNull();
    expect(q("link-connect-caption")!.textContent).toContain("使用 Aide 手机端扫码连接电脑");
  });

  it("倒计时只在最后一分钟提醒", async () => {
    createOfferMock.mockResolvedValue({ ...offer(), expiresAtUnix: Math.floor(Date.now() / 1000) + 45 });
    await openCard();
    expect(q("link-connect-caption")!.textContent).toMatch(/将在 0:\d\d 后失效/);
  });

  it("dev 构建不连网 / 连接出错时才露出状态行", async () => {
    statusMock.mockResolvedValue({ ...base, relaySuppressed: true });
    await openCard();
    expect(q("link-connect-state")!.textContent).toContain("不连");
  });

  it("关掉开关：先撤掉 Host 上那把一次性密钥再停网关，二维码收起", async () => {
    await openCard();
    const toggle = q("link-connect-toggle") as HTMLInputElement;
    toggle.checked = false;
    statusMock.mockResolvedValue({ ...base, enabled: false, offerActive: false });
    toggle.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(cancelOfferMock).toHaveBeenCalledTimes(1);
    expect(setEnabledMock).toHaveBeenCalledWith(false);
    expect(q("link-connect-qr")).toBeNull();
  });

  it("点卡片里面不收起", async () => {
    const w = await openCard();
    q("link-connect-card")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(q("link-connect-card")).not.toBeNull();
  });
});
