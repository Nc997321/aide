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
import type { ProviderConfig } from "../types";

const sd = (overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "__system_default__", kind: "system_default", name: "Anthropic", icon: "A", baseUrl: "",
  apiKey: "", authToken: "", model: "",
  modelMappings: { anthropicModel: "claude-3", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
  effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
  ...overrides,
});

const cpa = (): ProviderConfig => ({
  id: "cpa-local", kind: "cpa_gpt", name: "CPA 中转", icon: "C", baseUrl: "http://127.0.0.1:8317",
  apiKey: "", authToken: "sk-local-cpa", model: "",
  modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
  effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
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
    await updateProvider("cpa-local", { authToken: "sk-new" });
    expect(allProviders.value.find((p) => p.id === "cpa-local")?.authToken).toBe("sk-new");
    expect(api.setProviders).toHaveBeenCalled();
  });
});