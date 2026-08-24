import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import type { ProviderConfig, ProviderModelMappings } from "@/types";

// ── api mock：sessionProvider / sessionModel 返回受控值；setSessionProvider 记录写回 ──
const sessionProviderMock = vi.fn<(id: string) => Promise<string | null>>();
const sessionModelMock = vi.fn<(id: string) => Promise<string | null>>();
const setSessionProviderMock = vi.fn<(id: string, provider: string) => Promise<void>>();

vi.mock("@/api", () => ({
  api: {
    sessionProvider: (id: string) => sessionProviderMock(id),
    sessionModel: (id: string) => sessionModelMock(id),
    setSessionProvider: (id: string, provider: string) => setSessionProviderMock(id, provider),
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
    setSessionProviderMock.mockReset();
    setSessionProviderMock.mockResolvedValue(undefined);
    // 清 useSessionProviders 模块级注册表，避免用例间残留绑定
    const { providers } = useSessionProviders();
    for (const k of Object.keys(providers)) delete providers[k];
  });

  it("restoreBinding: 持久化供应商仍在 allProviders + 模型可信 → setProvider 恢复绑定，不写回", async () => {
    const allProviders = ref([makeProvider("p_a", "供应商A", "kimi"), makeProvider("p_b", "供应商B")]);
    const c = useSessionContinuity(allProviders);
    const { providerOf } = useSessionProviders();

    sessionProviderMock.mockResolvedValueOnce("p_a");
    sessionModelMock.mockResolvedValueOnce("kimi");

    await c.restoreBinding("sid-1");

    expect(providerOf("sid-1")).toBe("p_a");
    expect(c.lastUsedProvider.value).toBe("p_a");
    expect(c.lastUsedModel.value).toBe("kimi");
    expect(setSessionProviderMock).not.toHaveBeenCalled(); // 一致 → 不自愈写回
  });

  it("restoreBinding: 持久化供应商已被删且模型反查无果 → 无身份（回落全局 active），lastUsed 置 null", async () => {
    const allProviders = ref([makeProvider("p_a")]); // p_b 不在 allProviders 里
    const c = useSessionContinuity(allProviders);
    const { providerOf } = useSessionProviders();

    sessionProviderMock.mockResolvedValueOnce("p_b");
    sessionModelMock.mockResolvedValueOnce("deepseek"); // 也不在 p_a 列表 → 反查无果

    await c.restoreBinding("sid-2");

    expect(providerOf("sid-2")).toBeNull();
    expect(c.lastUsedProvider.value).toBeNull(); // 无身份：首次发送不弹确认（供应商已删，确认无意义）
    expect(c.lastUsedModel.value).toBe("deepseek");
  });

  it("restoreBinding: 供应商已被删但模型反查命中 → 修正绑定到命中 provider + self-heal 写回", async () => {
    const allProviders = ref([makeProvider("p_a", "供应商A", "deepseek")]);
    const c = useSessionContinuity(allProviders);
    const { providerOf } = useSessionProviders();

    sessionProviderMock.mockResolvedValueOnce("p_b"); // 被删的供应商
    sessionModelMock.mockResolvedValueOnce("deepseek"); // 反查到 p_a

    await c.restoreBinding("sid-3");

    expect(providerOf("sid-3")).toBe("p_a");
    expect(c.lastUsedProvider.value).toBe("p_a");
    expect(setSessionProviderMock).toHaveBeenCalledWith("sid-3", "p_a"); // 污染元数据被修正
  });

  it("restoreBinding: 污染特征（provider 盖写、model 是原供应商的）→ 按模型修正 + self-heal 写回", async () => {
    // 真实 bug 场景：会话 provider 被全局 active 盖写为 ollama，model 还是 kimi 的 k3[1m]
    const allProviders = ref([makeProvider("ollama", "Ollama", "glm-5.2"), makeProvider("kimi", "Kimi", "k3[1m]")]);
    const c = useSessionContinuity(allProviders);
    const { providerOf } = useSessionProviders();

    sessionProviderMock.mockResolvedValueOnce("ollama"); // 被污染的 provider 字段
    sessionModelMock.mockResolvedValueOnce("k3[1m]"); // 真实会话模型（不在 ollama 列表）

    await c.restoreBinding("sid-4");

    expect(providerOf("sid-4")).toBe("kimi"); // 修正回真实归属
    expect(c.lastUsedProvider.value).toBe("kimi");
    expect(c.lastUsedModel.value).toBe("k3[1m]");
    expect(setSessionProviderMock).toHaveBeenCalledWith("sid-4", "kimi");
  });

  it("restoreBinding: 系统默认供应商 → 直接信任，不写回", async () => {
    const allProviders = ref([makeProvider("__system_default__")]);
    const c = useSessionContinuity(allProviders);
    const { providerOf } = useSessionProviders();

    sessionProviderMock.mockResolvedValueOnce("__system_default__");
    sessionModelMock.mockResolvedValueOnce("claude-sonnet-4-5"); // 不在配置列表（SDK 动态模型）

    await c.restoreBinding("sid-5");

    expect(providerOf("sid-5")).toBe("__system_default__");
    expect(setSessionProviderMock).not.toHaveBeenCalled();
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
    expect(c.lastUsedProvider.value).toBe("p_a"); // 反查无果 → 保守保持原 provider
    expect(c.lastUsedModel.value).toBe("opus");
  });

  it("refreshLastUsed: 持久化 provider 被污染（模型是别的供应商的）→ lastUsed 用解析身份", async () => {
    // 存活会话切走又切回：内存绑定 kimi 是权威，但 `<sid>.json` 的 provider 字段
    // 仍是被盖写过的 ollama——needsConfirm 基线必须用解析身份，否则误弹确认。
    const allProviders = ref([makeProvider("ollama", "Ollama", "glm-5.2"), makeProvider("kimi", "Kimi", "k3[1m]")]);
    const c = useSessionContinuity(allProviders);
    const { providerOf, setProvider } = useSessionProviders();
    setProvider("sid-6", "kimi"); // 存活绑定（spawn 时解析出的真实身份）

    sessionProviderMock.mockResolvedValueOnce("ollama"); // 持久化仍是污染值
    sessionModelMock.mockResolvedValueOnce("k3[1m]");

    await c.refreshLastUsed("sid-6");

    expect(providerOf("sid-6")).toBe("kimi"); // 内存绑定不动
    expect(c.lastUsedProvider.value).toBe("kimi"); // 基线 = 解析身份 → 同身份发送不弹确认
    expect(c.needsConfirm("kimi", "k3[1m]")).toBe(false);
    expect(setSessionProviderMock).not.toHaveBeenCalled(); // 存活路径不写回
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