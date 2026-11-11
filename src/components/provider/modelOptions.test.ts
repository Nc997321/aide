import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@aide/sdk/types";
import { defaultModelOptions } from "./modelOptions";

function provider(): ProviderConfig {
  return {
    id: "p", kind: "custom", name: "Provider", icon: "provider", baseUrl: "",
    apiKeyConfigured: false, authTokenConfigured: false, model: "",
    modelMappings: {
      anthropicModel: "", defaultOpusModel: "main", defaultFableModel: "deep",
      defaultSonnetModel: "main", defaultHaikuModel: "fast", subagent: "fast",
    },
    effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", maxContextTokens: "",
    knownModels: ["deep", "other"],
  };
}

describe("defaultModelOptions", () => {
  it("从已配置的模型去重选择，包含 Fable、保留空值默认", () => {
    expect(defaultModelOptions(provider())).toEqual([
      { value: "", label: "使用供应商默认" },
      { value: "main", label: "main" },
      { value: "deep", label: "deep" },
      { value: "fast", label: "fast" },
      { value: "other", label: "other" },
    ]);
  });

  it("旧独立默认和上下文后缀不因映射不匹配而丢失", () => {
    const p = provider();
    p.modelMappings.anthropicModel = "legacy[1m]";
    expect(defaultModelOptions(p)).toContainEqual({ value: "legacy[1m]", label: "legacy[1m]" });
    p.modelMappings.defaultOpusModel = "new-main";
    expect(defaultModelOptions(p)).toContainEqual({ value: "legacy[1m]", label: "legacy[1m]" });
    expect(p.modelMappings.anthropicModel).toBe("legacy[1m]");
  });

  it("旧 Host 缺 Fable 字段、无已配模型时仍可使用供应商默认", () => {
    const p = provider();
    p.modelMappings = { anthropicModel: "", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" };
    p.knownModels = [];
    expect(defaultModelOptions(p)).toEqual([{ value: "", label: "使用供应商默认" }]);
  });

  it("官方别名可直接选择，沿用 Host 提供的版本标签", () => {
    const p = provider();
    p.kind = "system_default";
    p.knownModels = ["opus", "fable", "sonnet", "haiku"];
    p.modelLabels = { fable: "Fable 5.1" };
    expect(defaultModelOptions(p)).toContainEqual({ value: "fable", label: "Fable 5.1" });
  });
});
