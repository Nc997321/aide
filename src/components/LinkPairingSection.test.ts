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

import LinkPairingSection from "./LinkPairingSection.vue";

const base = {
  enabled: false,
  relayConfigured: true,
  relayUrl: "wss://relay.example",
  connected: false,
  relaySuppressed: false,
  lastError: "",
  deviceId: "00112233445566778899aabbccddeeff",
  hostName: "devbox",
  paired: false,
  offerActive: false,
};
const offer = () => ({
  uri: "aide-link://pair?v=1&relay=x&id=y&pk=z&psk=w&exp=1",
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>',
  expiresAtUnix: Math.floor(Date.now() / 1000) + 600,
});

async function mountIt() {
  const w = mount(LinkPairingSection);
  await flushPromises();
  return w;
}

describe("LinkPairingSection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    statusMock.mockReset().mockResolvedValue({ ...base });
    setEnabledMock.mockReset().mockImplementation(async (enabled: boolean) => ({ ...base, enabled }));
    createOfferMock.mockReset().mockResolvedValue(offer());
    cancelOfferMock.mockReset().mockResolvedValue(undefined);
    revokeMock.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("显示这台 Host 的名字与状态；未启用时说未启用", async () => {
    const w = await mountIt();
    expect(w.text()).toContain("devbox");
    expect(w.get('[data-testid="link-state"]').text()).toBe("未启用");
    expect(w.get('[data-testid="link-paired"]').text()).toBe("尚未配对");
  });

  it("dev 构建不连中继：如实说明，而不是一直显示「正在连接」", async () => {
    statusMock.mockResolvedValue({ ...base, enabled: true, relaySuppressed: true });
    const w = await mountIt();
    expect(w.get('[data-testid="link-state"]').text()).toContain("不连中继");
  });

  it("没配中继地址：不能配对，并提示去填中继 URL", async () => {
    statusMock.mockResolvedValue({ ...base, relayConfigured: false, relayUrl: "" });
    const w = await mountIt();
    expect(w.get('[data-testid="link-pair"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-testid="link-needs-relay"]').exists()).toBe(true);
  });

  it("点「配对手机」：显示二维码——只作为 <img> 的 data URL，绝不把 Host 给的 SVG 内联进 DOM", async () => {
    statusMock.mockResolvedValue({ ...base, enabled: true, offerActive: true }); // 生成后 Host 上二维码是有效的
    const w = await mountIt();
    await w.get('[data-testid="link-pair"]').trigger("click");
    await flushPromises();
    expect(createOfferMock).toHaveBeenCalledTimes(1);
    const img = w.get(".link-qr");
    expect(img.attributes("src")).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(w.html()).not.toContain("<script");
    expect(w.find("svg").exists()).toBe(false);
  });

  it("手机配对成功（二维码被用掉）：收起二维码并提示成功", async () => {
    const w = await mountIt();
    statusMock.mockResolvedValue({ ...base, enabled: true, connected: true, offerActive: true });
    await w.get('[data-testid="link-pair"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-testid="link-offer"]').exists()).toBe(true);

    statusMock.mockResolvedValue({ ...base, enabled: true, connected: true, paired: true, offerActive: false });
    vi.advanceTimersByTime(2100);
    await flushPromises();
    expect(w.find('[data-testid="link-offer"]').exists()).toBe(false);
    expect(w.get('[data-testid="link-note"]').text()).toContain("配对成功");
    expect(w.get('[data-testid="link-paired"]').text()).toBe("已配对 1 台手机");
  });

  it("二维码过期：收起并提示重新生成", async () => {
    createOfferMock.mockResolvedValue({ ...offer(), expiresAtUnix: Math.floor(Date.now() / 1000) + 1 });
    const w = await mountIt();
    statusMock.mockResolvedValue({ ...base, enabled: true, offerActive: true });
    await w.get('[data-testid="link-pair"]').trigger("click");
    await flushPromises();
    vi.advanceTimersByTime(4000);
    await flushPromises();
    expect(w.find('[data-testid="link-offer"]').exists()).toBe(false);
    expect(w.get('[data-testid="link-note"]').text()).toContain("过期");
  });

  it("关闭二维码 = 撤掉这把一次性密钥；卸载面板时二维码还开着也撤掉", async () => {
    statusMock.mockResolvedValue({ ...base, enabled: true, offerActive: true });
    const w = await mountIt();
    await w.get('[data-testid="link-pair"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="link-cancel"]').trigger("click");
    await flushPromises();
    expect(cancelOfferMock).toHaveBeenCalledTimes(1);
    expect(w.find('[data-testid="link-offer"]').exists()).toBe(false);

    statusMock.mockResolvedValue({ ...base, enabled: true, offerActive: true });
    await w.get('[data-testid="link-pair"]').trigger("click");
    await flushPromises();
    w.unmount();
    expect(cancelOfferMock).toHaveBeenCalledTimes(2);
  });

  it("撤销已配对手机", async () => {
    statusMock.mockResolvedValue({ ...base, enabled: true, connected: true, paired: true });
    const w = await mountIt();
    await w.get('[data-testid="link-revoke"]').trigger("click");
    await flushPromises();
    expect(revokeMock).toHaveBeenCalledTimes(1);
    expect(w.get('[data-testid="link-note"]').text()).toContain("已撤销");
  });

  it("开关启停网关；失败如实显示", async () => {
    const w = await mountIt();
    const toggle = w.get('[data-testid="link-toggle"]');
    (toggle.element as HTMLInputElement).checked = true;
    await toggle.trigger("change");
    await flushPromises();
    expect(setEnabledMock).toHaveBeenCalledWith(true);
    expect(w.get('[data-testid="link-state"]').text()).toContain("已启用");

    createOfferMock.mockRejectedValue("请先在设置里配置中继地址");
    await w.get('[data-testid="link-pair"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-testid="link-error"]').text()).toContain("中继");
  });
});
