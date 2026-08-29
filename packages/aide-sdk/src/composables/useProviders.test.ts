import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    getProviders: vi.fn(),
    setProviders: vi.fn(),
    getActiveProviderId: vi.fn(),
    setActiveProviderId: vi.fn(),
    refreshModels: vi.fn(),
    getProviderCatalog: vi.fn().mockResolvedValue([]),
  },
}));

import { api } from "../api";
import { useProviders } from "./useProviders";
import { useProviderCatalog } from "./useProviderCatalog";
import type { ProviderConfig } from "../types";

const sd = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "__system_default__", kind: "system_default", name: "Anthropic", icon: "A", baseUrl: "",
  apiKeyConfigured: false, authTokenConfigured: false, model: "",
  modelMappings: { anthropicModel: "claude-3", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
  effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", maxContextTokens: "", knownModels: [],
  ...overrides,
});

const cpa = (): ProviderConfig => ({
  id: "cpa-local", kind: "cpa_gpt", name: "CPA 中转", icon: "C", baseUrl: "http://127.0.0.1:8317",
  apiKeyConfigured: false, authTokenConfigured: true, model: "",
  modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
  effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", maxContextTokens: "", knownModels: [],
});

describe("useProviders — SystemDefault 统一", () => {
  const P = useProviders();
  const { allProviders, displayList, activeProvider, systemDefault, systemDefaultMappings, load, updateProvider, saveSystemDefaultMappings, refreshSystemDefaultModels, __resetForTest } = P;

  beforeEach(() => {
    __resetForTest();
    (api.getProviders as any).mockReset();
    (api.getActiveProviderId as any).mockReset();
    (api.refreshModels as any).mockReset();
    (api.setProviders as any).mockReset().mockResolvedValue(undefined);
  });

  it("load 后 allProviders 含 SystemDefault 真实条目（来自 get_providers，不再虚拟前置）", async () => {
    (api.getProviders as any).mockResolvedValue([sd(), cpa()]);
    (api.getActiveProviderId as any).mockResolvedValue("__system_default__");
    await load();
    expect(allProviders.value.map((p) => p.id)).toEqual(["__system_default__", "cpa-local"]);
  });

  it("displayList = allProviders（SystemDefault 已在数组里，不重复前置）", async () => {
    (api.getProviders as any).mockResolvedValue([sd(), cpa()]);
    (api.getActiveProviderId as any).mockResolvedValue("cpa-local");
    await load();
    expect(displayList.value).toHaveLength(2);
    expect(displayList.value[0].id).toBe("__system_default__");
  });

  it("systemDefault computed 找 id=__system_default__ 的条目", async () => {
    (api.getProviders as any).mockResolvedValue([sd({ name: "Anthropic 官方" }), cpa()]);
    (api.getActiveProviderId as any).mockResolvedValue("cpa-local");
    await load();
    expect(systemDefault.value?.name).toBe("Anthropic 官方");
  });

  it("systemDefaultMappings computed 从 systemDefault.modelMappings 派生（不再独立 ref）", async () => {
    (api.getProviders as any).mockResolvedValue([sd()]);
    (api.getActiveProviderId as any).mockResolvedValue("__system_default__");
    await load();
    expect(systemDefaultMappings.value.anthropicModel).toBe("claude-3");
  });

  it("activeProvider 找不到时回落 SystemDefault", async () => {
    (api.getProviders as any).mockResolvedValue([sd()]);
    (api.getActiveProviderId as any).mockResolvedValue("nope");
    await load();
    expect(activeProvider.value.id).toBe("__system_default__");
  });

  it("saveSystemDefaultMappings 走 updateProvider(__system_default__, …)（不再调废弃 setSystemDefaultModelMappings）", async () => {
    (api.getProviders as any).mockResolvedValue([sd()]);
    (api.getActiveProviderId as any).mockResolvedValue("__system_default__");
    await load();
    await saveSystemDefaultMappings({ anthropicModel: "claude-4", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" });
    expect(api.setProviders).toHaveBeenCalledTimes(1);
    const saved = (api.setProviders as any).mock.calls[0][0] as ProviderConfig[];
    expect(saved.find((p) => p.id === "__system_default__")?.modelMappings.anthropicModel).toBe("claude-4");
  });

  it("refreshSystemDefaultModels 调 api.refreshModels('__system_default__')（不再调废弃 refreshSystemDefaultModels）", async () => {
    (api.getProviders as any).mockResolvedValue([sd()]);
    (api.getActiveProviderId as any).mockResolvedValue("__system_default__");
    (api.refreshModels as any).mockResolvedValue({ anthropicModel: "claude-4", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" });
    await load();
    await refreshSystemDefaultModels();
    expect(api.refreshModels).toHaveBeenCalledWith("__system_default__");
  });

  it("updateProvider 合并并落盘 setProviders", async () => {
    (api.getProviders as any).mockResolvedValue([sd(), cpa()]);
    (api.getActiveProviderId as any).mockResolvedValue("cpa-local");
    await load();
    await updateProvider("cpa-local", {}, { authToken: { action: "set", value: "sk-new" } });
    expect(allProviders.value.find((p) => p.id === "cpa-local")?.authTokenConfigured).toBe(true);
    expect(api.setProviders).toHaveBeenCalled();
  });
});

describe("useProviders — kind-aware add", () => {
  const P = useProviders();
  const C = useProviderCatalog();
  const { allProviders, addPresetProvider, addCustomProvider, __resetForTest } = P;

  beforeEach(async () => {
    P.__resetForTest();
    C.__resetForTest();
    (api.getProviders as any).mockReset().mockResolvedValue([]);
    (api.setProviders as any).mockReset().mockResolvedValue(undefined);
    (api.getProviderCatalog as any).mockResolvedValue([
      { kind: "cpa_gpt", name: "CPA 中转", icon: "C", base_url: "http://127.0.0.1:8317", auth_mode: "auth_token", actions: [] },
      { kind: "ollama", name: "Ollama", icon: "O", base_url: "https://ollama.com", auth_mode: "api_key", actions: [] },
    ]);
    await C.loadCatalog();
  });

  it("addPresetProvider(kind) 创建该 kind 实例，kind 正确，身份从 catalog 富化显示", async () => {
    const p = await addPresetProvider("cpa_gpt");
    expect(p.kind).toBe("cpa_gpt");
    expect(p.name).toBe("CPA 中转");
    expect(p.baseUrl).toBe("http://127.0.0.1:8317");
    expect(p.authTokenConfigured).toBe(false);
    expect(p.id).not.toBe("");
  });

  it("addPresetProvider 单实例 guard：已存在的 kind 抛错", async () => {
    await addPresetProvider("cpa_gpt");
    await expect(addPresetProvider("cpa_gpt")).rejects.toThrow(/已存在|single instance/i);
  });

  it("addPresetProvider 落盘 setProviders（Rust 会 strip 身份字段，只存 kind+creds+mappings）", async () => {
    await addPresetProvider("ollama");
    expect(api.setProviders).toHaveBeenCalledTimes(1);
  });

  it("addCustomProvider 创建 kind=custom 实例，身份字段留空待用户填", async () => {
    const p = await addCustomProvider();
    expect(p.kind).toBe("custom");
    expect(p.name).toBe("新供应商");
    expect(p.baseUrl).toBe("");
    // maxContextTokens 经 addProvider 的 `partial.maxContextTokens ?? ""` 兜底为空
    // （addCustomProvider 不透传该字段 → undefined → ""）。验证 nullish 臂。
    expect(p.maxContextTokens).toBe("");
  });
});