// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const { statusMock, setEnabledMock, createOfferMock, cancelOfferMock, revokeMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  setEnabledMock: vi.fn(),
  createOfferMock: vi.fn(),
  cancelOfferMock: vi.fn(),
  revokeMock: vi.fn(),
}));

vi.mock("@aide/sdk", () => ({
  linkApi: {
    status: statusMock,
    setEnabled: setEnabledMock,
    createOffer: createOfferMock,
    cancelOffer: cancelOfferMock,
    revoke: revokeMock,
  },
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
};
const offer = () => ({
  uri: "aide-link://pair?v=1",
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>',
  expiresAtUnix: Math.floor(Date.now() / 1000) + 600,
});

const tooltip = { mounted() {}, updated() {} };
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

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
    createOfferMock.mockReset().mockResolvedValue(offer());
    cancelOfferMock.mockReset().mockResolvedValue(undefined);
    revokeMock.mockReset().mockResolvedValue(undefined);
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

  it("不展示中继：卡片里没有任何 URL / 中继字样（中继是产品内置的）", async () => {
    await openCard();
    const text = q("link-connect-card")!.textContent ?? "";
    expect(text).not.toMatch(/wss?:\/\//);
    expect(text).not.toContain("中继");
    expect(q("link-connect-card")!.querySelector("input[type=text]")).toBeNull();
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
