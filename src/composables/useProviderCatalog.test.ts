import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api", () => ({
  api: {
    getProviderCatalog: vi.fn(),
  },
}));

import { api } from "../api";
import { useProviderCatalog } from "./useProviderCatalog";
import type { CatalogPreset, ProviderConfig, ProviderKind } from "../types";

const FIXTURE: CatalogPreset[] = [
  { kind: "system_default", name: "Anthropic", icon: "A", base_url: "", auth_mode: "api_key", actions: ["refresh_models", "view_quota", "test_connection"] },
  { kind: "cpa_gpt", name: "CPA 中转", icon: "C", base_url: "http://127.0.0.1:8317", auth_mode: "auth_token", actions: ["probe_port", "open_management", "codex_login_status", "test_connection"] },
  { kind: "ollama", name: "Ollama", icon: "O", base_url: "https://ollama.com", auth_mode: "api_key", actions: ["test_connection"] },
];

describe("useProviderCatalog", () => {
  const { catalog, presetForKind, availablePresets, enrichForDisplay, loadCatalog, __resetForTest } = useProviderCatalog();

  beforeEach(() => {
    __resetForTest();
    (api.getProviderCatalog as any).mockReset();
    (api.getProviderCatalog as any).mockResolvedValue(FIXTURE);
  });

  it("loadCatalog 填 catalog ref", async () => {
    await loadCatalog();
    expect(catalog.value).toHaveLength(3);
    expect(catalog.value[0].kind).toBe("system_default");
  });

  it("presetForKind 命中返回 preset，未命中（custom）返回 undefined", () => {
    // 未 load 时 catalog 空 → 返回 undefined
    expect(presetForKind("cpa_gpt")).toBeUndefined();
  });

  it("presetForKind load 后命中", async () => {
    await loadCatalog();
    expect(presetForKind("cpa_gpt")?.name).toBe("CPA 中转");
    expect(presetForKind("custom")).toBeUndefined();
  });

  it("availablePresets 过滤掉已添加的 kind（单实例约束）", async () => {
    await loadCatalog();
    const added: ProviderKind[] = ["system_default", "cpa_gpt"];
    const avail = availablePresets(added);
    expect(avail.map((p) => p.kind)).toEqual(["ollama"]);
  });

  it("enrichForDisplay 给预置 kind 填 name/icon/baseUrl（从 catalog 派生，不动 creds）", async () => {
    await loadCatalog();
    const p: ProviderConfig = {
      id: "x", kind: "cpa_gpt", name: "", icon: "", baseUrl: "",
      apiKey: "", authToken: "sk-local", model: "",
      modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
      effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
    };
    const enriched = enrichForDisplay(p);
    expect(enriched.name).toBe("CPA 中转");
    expect(enriched.icon).toBe("C");
    expect(enriched.baseUrl).toBe("http://127.0.0.1:8317");
    expect(enriched.authToken).toBe("sk-local");
    expect(enriched.kind).toBe("cpa_gpt");
  });

  it("enrichForDisplay 对 Custom 原样返回（不富化）", async () => {
    await loadCatalog();
    const p: ProviderConfig = {
      id: "c", kind: "custom", name: "my", icon: "M", baseUrl: "https://gw",
      apiKey: "k", authToken: "", model: "",
      modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
      effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
    };
    const enriched = enrichForDisplay(p);
    expect(enriched.name).toBe("my");
    expect(enriched.baseUrl).toBe("https://gw");
  });

  it("enrichForDisplay 在 catalog 未加载时对预置 kind 不崩（返回原样）", () => {
    const p: ProviderConfig = {
      id: "x", kind: "ollama", name: "", icon: "", baseUrl: "",
      apiKey: "", authToken: "", model: "",
      modelMappings: { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
      effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", knownModels: [],
    };
    const enriched = enrichForDisplay(p);
    expect(enriched.kind).toBe("ollama");
    // catalog 空 → 不富化，不崩
    expect(enriched.name).toBe("");
  });
});
