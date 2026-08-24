import { describe, it, expect } from "vitest";
import type { ProviderConfig, ProviderModelMappings } from "@/types";
import { SYSTEM_DEFAULT_ID, providerModelList, findProviderForModel, consistentProviderId } from "./provider";

const emptyMappings = (): ProviderModelMappings => ({
  anthropicModel: "",
  defaultOpusModel: "",
  defaultSonnetModel: "",
  defaultHaikuModel: "",
  subagent: "",
});

function makeProvider(
  id: string,
  opts: Partial<{ model: string; mappings: Partial<ProviderModelMappings>; knownModels: string[] }> = {},
): ProviderConfig {
  return {
    id,
    kind: id === SYSTEM_DEFAULT_ID ? "system_default" : "custom",
    name: id,
    icon: "provider",
    baseUrl: "",
    apiKeyConfigured: false,
    authTokenConfigured: false,
    model: opts.model ?? "",
    modelMappings: { ...emptyMappings(), ...opts.mappings },
    effortLevel: "",
    autoCompactWindow: "",
    autocompactPctOverride: "",
    maxContextTokens: "",
    knownModels: opts.knownModels ?? [],
  };
}

describe("providerModelList", () => {
  it("合并顶层 model + 映射字段 + knownModels，去空去重", () => {
    const p = makeProvider("kimi", {
      model: "k3[1m]",
      mappings: { anthropicModel: "k3[1m]", defaultSonnetModel: "kimi-k2", subagent: "" },
      knownModels: ["kimi-k2", "kimi-k3"],
    });
    expect(providerModelList(p)).toEqual(["k3[1m]", "kimi-k2", "kimi-k3"]);
  });

  it("全部空 → 空列表（系统默认常态）", () => {
    expect(providerModelList(makeProvider(SYSTEM_DEFAULT_ID))).toEqual([]);
  });

  it("空串与 undefined 字段被过滤", () => {
    const p = makeProvider("p", { model: "m1", mappings: { anthropicModel: "", defaultOpusModel: "m2" } });
    expect(providerModelList(p)).toEqual(["m1", "m2"]);
  });
});

describe("findProviderForModel", () => {
  const ps = [
    makeProvider("kimi", { model: "k3[1m]" }),
    makeProvider("ollama", { model: "glm-5.2", knownModels: ["deepseek-v4-flash"] }),
  ];

  it("空 model → null", () => {
    expect(findProviderForModel(ps, "")).toBeNull();
  });

  it("命中 → 返回该 provider", () => {
    expect(findProviderForModel(ps, "k3[1m]")?.id).toBe("kimi");
    expect(findProviderForModel(ps, "deepseek-v4-flash")?.id).toBe("ollama");
  });

  it("多个命中 → 取列表第一个（确定性）", () => {
    const ps2 = [
      makeProvider("a", { model: "x" }),
      makeProvider("b", { knownModels: ["x"] }),
    ];
    expect(findProviderForModel(ps2, "x")?.id).toBe("a");
  });

  it("未命中 → null", () => {
    expect(findProviderForModel(ps, "gpt-4o")).toBeNull();
  });
});

describe("consistentProviderId", () => {
  const ollama = makeProvider("ollama", { model: "glm-5.2", knownModels: ["deepseek-v4-flash"] });
  const kimi = makeProvider("kimi", { model: "k3[1m]" });
  const sysDefault = makeProvider(SYSTEM_DEFAULT_ID);
  const ps = [ollama, kimi, sysDefault];

  it("provider 缺失（新会话）+ 无模型 → null（回落全局 active）", () => {
    expect(consistentProviderId(ps, null, null)).toBeNull();
  });

  it("provider 缺失 + 模型反查命中 → 该 provider", () => {
    expect(consistentProviderId(ps, null, "k3[1m]")).toBe("kimi");
  });

  it("provider 缺失 + 模型反查无果 → null", () => {
    expect(consistentProviderId(ps, null, "gpt-4o")).toBeNull();
  });

  it("provider 已被删 + 模型反查命中 → 修正为命中 provider", () => {
    expect(consistentProviderId(ps, "deleted-provider", "k3[1m]")).toBe("kimi");
  });

  it("provider 已被删 + 模型反查无果 → null", () => {
    expect(consistentProviderId(ps, "deleted-provider", "gpt-4o")).toBeNull();
  });

  it("provider 是系统默认 → 直接信任（模型列表空是常态）", () => {
    expect(consistentProviderId(ps, SYSTEM_DEFAULT_ID, "claude-sonnet-4-5")).toBe(SYSTEM_DEFAULT_ID);
  });

  it("provider 存在 + 模型空 → 信任（没记过模型）", () => {
    expect(consistentProviderId(ps, "ollama", null)).toBe("ollama");
  });

  it("provider 存在 + 模型在列表 → 信任", () => {
    expect(consistentProviderId(ps, "ollama", "glm-5.2")).toBe("ollama");
  });

  it("污染特征：provider 存在但模型不在其列表 → 按模型反查修正", () => {
    // 典型污染：provider 被全局 active 盖写（ollama），model 还是原供应商的（k3[1m]）
    expect(consistentProviderId(ps, "ollama", "k3[1m]")).toBe("kimi");
  });

  it("污染反查无果 → 保守保持原 provider（不动拿不准的数据）", () => {
    expect(consistentProviderId(ps, "ollama", "gpt-4o")).toBe("ollama");
  });

  it("空 providers 列表（供应商全无）→ null", () => {
    expect(consistentProviderId([], "p-x", "m")).toBeNull();
    expect(consistentProviderId([], null, null)).toBeNull();
  });
});
