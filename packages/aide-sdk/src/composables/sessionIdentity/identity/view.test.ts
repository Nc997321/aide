import { describe, it, expect, vi, beforeEach } from "vitest";
import { useProviders } from "../../../composables/useProviders";
import { useSessionProviders } from "../../../composables/useSessionProviders";
import type { ProviderConfig, ProviderModelMappings } from "../../../types";
import type { ModelOption, SessionMetaPatch } from "../../../types/chat";

const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();
const setSessionMetaMock = vi.fn<(id: string, patch: SessionMetaPatch) => Promise<void>>();
const getDefaultModelsMock = vi.fn<() => Promise<ModelOption[]>>();

vi.mock("../../../api", () => ({
  api: {
    sessionProvider: (id: string) => sessionProviderMock(id),
    sessionModel: (id: string) => sessionModelMock(id),
    setSessionMeta: (id: string, patch: SessionMetaPatch) => setSessionMetaMock(id, patch),
    getDefaultModels: () => getDefaultModelsMock(),
  },
}));

import { sessionIdentityStore } from "./store";
import { createSessionIdentityView } from "./view";

const emptyMappings = (): ProviderModelMappings => ({
  anthropicModel: "",
  defaultOpusModel: "",
  defaultSonnetModel: "",
  defaultHaikuModel: "",
  subagent: "",
});

function makeProvider(id: string, model = `${id}-default`, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id,
    kind: "custom",
    name: id,
    icon: "p",
    baseUrl: "",
    apiKeyConfigured: false,
    authTokenConfigured: false,
    model,
    modelMappings: emptyMappings(),
    effortLevel: "",
    autoCompactWindow: "",
    autocompactPctOverride: "",
    maxContextTokens: "",
    knownModels: [],
    ...extra,
  };
}

/**
 * 视图层的存在意义：**每个面板一份**，互不干扰。
 * 此前这些状态是模块级单值，分屏（多面板同时挂载）下谁最后切面板谁改全局。
 */
describe("sessionIdentityView (L2b 视图)", () => {
  const { allProviders, activeProviderId } = useProviders();
  const { providers } = useSessionProviders();

  beforeEach(() => {
    sessionProviderMock.mockReset();
    sessionModelMock.mockReset();
    setSessionMetaMock.mockReset();
    getDefaultModelsMock.mockReset();
    setSessionMetaMock.mockResolvedValue(undefined);
    getDefaultModelsMock.mockResolvedValue([]);
    sessionProviderMock.mockResolvedValue(null);
    sessionModelMock.mockResolvedValue(null);
    for (const k of Object.keys(providers)) delete providers[k];
    sessionIdentityStore.__resetForTest();
  });

  it("两份视图的 currentSid 互不影响", async () => {
    allProviders.value = [makeProvider("p_a", "kimi"), makeProvider("p_b", "deepseek")];
    activeProviderId.value = "p_a";
    // 两条会话分属不同供应商（盘上 meta 不同）
    sessionProviderMock.mockImplementation(async (id) => (id === "s2" ? "p_b" : "p_a"));
    sessionModelMock.mockImplementation(async (id) => (id === "s2" ? "deepseek" : "kimi"));
    const a = createSessionIdentityView();
    const b = createSessionIdentityView();
    await a.focusSession("s1");
    await b.focusSession("s2");
    expect(a.currentSid.value).toBe("s1");
    expect(b.currentSid.value).toBe("s2");
    // 未启动 → 都跟随全局，不看盘上 meta（这正是第 3 笔的行为变更）
    expect(a.effectiveProvider.value).toBe("p_a");
    expect(b.effectiveProvider.value).toBe("p_a");
  });

  it("已 spawn 的会话锁定自己的供应商，两个面板互不干扰", async () => {
    allProviders.value = [makeProvider("p_a", "kimi"), makeProvider("p_b", "deepseek")];
    activeProviderId.value = "p_a";
    sessionProviderMock.mockImplementation(async (id) => (id === "s2" ? "p_b" : "p_a"));
    sessionModelMock.mockImplementation(async (id) => (id === "s2" ? "deepseek" : "kimi"));
    const a = createSessionIdentityView();
    const b = createSessionIdentityView();
    await sessionIdentityStore.settleOnSend("s1", "p_a");
    await sessionIdentityStore.settleOnSend("s2", "p_b");
    await a.focusSession("s1");
    await b.focusSession("s2");
    // 全局再切到 p_b，s1 仍锁 p_a（有活进程），s2 是 p_b
    activeProviderId.value = "p_b";
    expect(a.effectiveProvider.value).toBe("p_a");
    expect(b.effectiveProvider.value).toBe("p_b");
  });

  it("回归：门控基线按 sid 隔离——两个面板各自拿到自己会话的 lastProvider（此前是全局单值，会串）", async () => {
    allProviders.value = [makeProvider("p_a", "kimi"), makeProvider("p_b", "deepseek")];
    activeProviderId.value = "p_a";
    // 两条会话分属不同供应商：s1 → p_a，s2 → p_b
    sessionProviderMock.mockImplementation(async (id) => (id === "s2" ? "p_b" : "p_a"));
    sessionModelMock.mockImplementation(async (id) => (id === "s2" ? "deepseek" : "kimi"));
    const a = createSessionIdentityView();
    const b = createSessionIdentityView();
    await a.focusSession("s1");
    await b.focusSession("s2");
    expect(a.lastProvider.value).toBe("p_a");
    expect(b.lastProvider.value).toBe("p_b");
  });

  it("回归：在 A 面板选模型只写进 A 的会话，不落到 B（此前 setUserChoice 按全局 currentSid 写）", async () => {
    allProviders.value = [
      makeProvider("p_a", "kimi", { knownModels: ["kimi", "picked-in-a"] }),
    ];
    activeProviderId.value = "p_a";
    const a = createSessionIdentityView();
    const b = createSessionIdentityView();
    await a.focusSession("s1");
    await b.focusSession("s2");
    a.setUserChoice("picked-in-a");
    expect(a.effectiveModel.value).toBe("picked-in-a");
    // s2 没有 binding → 回落列表首项，绝不能是 A 面板的选择
    expect(b.effectiveModel.value).toBe("kimi");
  });

  it("空白面板（无 sid）的草稿只属于本面板", () => {
    allProviders.value = [makeProvider("p_a", "kimi", { knownModels: ["kimi", "picked"] })];
    activeProviderId.value = "p_a";
    const a = createSessionIdentityView();
    const b = createSessionIdentityView();
    a.setUserChoice("picked");
    expect(a.effectiveModel.value).toBe("picked");
    expect(b.effectiveModel.value).toBe("kimi");
  });

  it("空白面板草稿不在全局列表 → 回落首项", () => {
    allProviders.value = [makeProvider("p_a", "kimi")];
    activeProviderId.value = "p_a";
    const a = createSessionIdentityView();
    a.setUserChoice("not-in-list");
    expect(a.effectiveModel.value).toBe("kimi");
  });

  it("focusSession 期间又切走 → 返回 false（调用方据此放弃后续赋值）", async () => {
    allProviders.value = [makeProvider("p_a", "kimi")];
    activeProviderId.value = "p_a";
    const a = createSessionIdentityView();
    const first = a.focusSession("s1");
    const second = a.focusSession("s2"); // 第一次 await 完成前又切
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(a.currentSid.value).toBe("s2");
  });

  it("clearCurrent / adoptSid 只影响本面板", async () => {
    allProviders.value = [makeProvider("p_a", "kimi")];
    activeProviderId.value = "p_a";
    const a = createSessionIdentityView();
    const b = createSessionIdentityView();
    await a.focusSession("s1");
    await b.focusSession("s2");
    a.clearCurrent();
    expect(a.currentSid.value).toBeNull();
    expect(b.currentSid.value).toBe("s2");
    a.adoptSid("s1");
    expect(a.currentSid.value).toBe("s1");
    expect(b.currentSid.value).toBe("s2");
  });
});
