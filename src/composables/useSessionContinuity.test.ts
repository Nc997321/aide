import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import type { ProviderConfig, ProviderModelMappings } from "@/types";

// ── api mock：sessionProvider / sessionModel 返回受控值 ──
const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();

vi.mock("@/api", () => ({
  api: {
    sessionProvider: (id: string) => sessionProviderMock(id),
    sessionModel: (id: string) => sessionModelMock(id),
  },
}));

import { useSessionContinuity } from "./useSessionContinuity";
import { useSessionProviders } from "./useSessionProviders";

const emptyMappings = (): ProviderModelMappings => ({
  anthropicModel: "",
  defaultOpusModel: "",
  defaultSonnetModel: "",
  defaultHaikuModel: "",
  subagent: "",
});

function makeProvider(id: string, name = id, model = `${id}-default`): ProviderConfig {
  return {
    id,
    kind: "custom",
    name,
    icon: "provider",
    baseUrl: "",
    apiKeyConfigured: false,
    authTokenConfigured: false,
    model,
    modelMappings: emptyMappings(),
    effortLevel: "",
    autoCompactWindow: "",
    autocompactPctOverride: "",
    knownModels: [],
  };
}

describe("useSessionContinuity", () => {
  beforeEach(() => {
    sessionProviderMock.mockReset();
    sessionModelMock.mockReset();
    // 清 useSessionProviders 模块级注册表，避免用例间残留绑定
    const { providers } = useSessionProviders();
    for (const k of Object.keys(providers)) delete providers[k];
  });

  it("restoreBinding: 持久化供应商仍在 allProviders → setProvider 恢复绑定 + lastUsed 置位", async () => {
    const allProviders = ref([makeProvider("p_a", "供应商A"), makeProvider("p_b", "供应商B")]);
    const c = useSessionContinuity(allProviders);
    const { providerOf } = useSessionProviders();

    sessionProviderMock.mockResolvedValueOnce("p_a");
    sessionModelMock.mockResolvedValueOnce("kimi");

    await c.restoreBinding("sid-1");

    expect(providerOf("sid-1")).toBe("p_a");
    expect(c.lastUsedProvider.value).toBe("p_a");
    expect(c.lastUsedModel.value).toBe("kimi");
  });

  it("restoreBinding: 持久化供应商已被删 → 不恢复绑定，lastUsed 仍读回（作 confirm 文案）", async () => {
    const allProviders = ref([makeProvider("p_a")]); // p_b 不在 allProviders 里
    const c = useSessionContinuity(allProviders);
    const { providerOf } = useSessionProviders();

    sessionProviderMock.mockResolvedValueOnce("p_b");
    sessionModelMock.mockResolvedValueOnce("deepseek");

    await c.restoreBinding("sid-2");

    expect(providerOf("sid-2")).toBeNull();
    expect(c.lastUsedProvider.value).toBe("p_b");
    expect(c.lastUsedModel.value).toBe("deepseek");
  });

  it("refreshLastUsed: 只读 lastUsed，不动内存绑定", async () => {
    const allProviders = ref([makeProvider("p_a")]);
    const c = useSessionContinuity(allProviders);
    const { providerOf, setProvider } = useSessionProviders();
    setProvider("sid-3", "p_a"); // 已有内存绑定

    sessionProviderMock.mockResolvedValueOnce("p_a");
    sessionModelMock.mockResolvedValueOnce("opus");

    await c.refreshLastUsed("sid-3");

    expect(providerOf("sid-3")).toBe("p_a"); // 绑定未变
    expect(c.lastUsedProvider.value).toBe("p_a");
    expect(c.lastUsedModel.value).toBe("opus");
  });

  it("clear: 清空 lastUsed", () => {
    const c = useSessionContinuity(ref([makeProvider("p_a")]));
    c.lastUsedModel.value = "x";
    c.lastUsedProvider.value = "p_a";
    c.clear();
    expect(c.lastUsedModel.value).toBeNull();
    expect(c.lastUsedProvider.value).toBeNull();
  });

  it("needsConfirm: lastUsedProvider 为 null（首次 spawn）→ false（不弹）", () => {
    const c = useSessionContinuity(ref([makeProvider("p_a")]));
    expect(c.needsConfirm("p_a", "kimi")).toBe(false);
    expect(c.needsConfirm("p_b", "deepseek")).toBe(false);
  });

  it("needsConfirm: provider 变了 → true", async () => {
    const c = useSessionContinuity(ref([makeProvider("p_a"), makeProvider("p_b")]));
    sessionProviderMock.mockResolvedValueOnce("p_a");
    sessionModelMock.mockResolvedValueOnce("kimi");
    await c.restoreBinding("sid");
    expect(c.needsConfirm("p_b", "kimi")).toBe(true);
  });

  it("needsConfirm: 模型变了 → true；provider/模型都同 → false", async () => {
    const c = useSessionContinuity(ref([makeProvider("p_a")]));
    sessionProviderMock.mockResolvedValueOnce("p_a");
    sessionModelMock.mockResolvedValueOnce("kimi");
    await c.restoreBinding("sid");
    expect(c.needsConfirm("p_a", "deepseek")).toBe(true); // 模型不同
    expect(c.needsConfirm("p_a", "kimi")).toBe(false); // 都同
  });

  it("noteSent: 推进基线后，同值不再 needsConfirm", async () => {
    const c = useSessionContinuity(ref([makeProvider("p_a")]));
    sessionProviderMock.mockResolvedValueOnce("p_a");
    sessionModelMock.mockResolvedValueOnce("kimi");
    await c.restoreBinding("sid");
    expect(c.needsConfirm("p_a", "deepseek")).toBe(true);
    c.noteSent("p_a", "deepseek");
    expect(c.needsConfirm("p_a", "deepseek")).toBe(false); // 基线已推进到新值
  });
});