// 自动化编辑器的模型下拉：来源必须是**当前供应商**的模型列表（与聊天面板同源），
// 不是一份写死的 Claude 名单。
//
// 2026-09-20 修：此前 AutomationTaskEditor.vue 里写死 STATIC_MODELS
// （claude-sonnet-5 / claude-opus-5 / claude-fable-5 + 价格文案），配了第三方供应商
// 时这些名字既不是该供应商的模型、也可能被端点直接拒（400/404）；而系统默认供应
// 商下的可选名是 CLI 别名（opus/sonnet/haiku/fable）——两边都对不上。
import { describe, it, expect, beforeEach, vi } from "vitest";

// useProviders → @aide/sdk/api → transport 的 import 链在测试环境只需不炸（不实际调用）。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useProviders } from "@/composables/useProviders";
import type { ProviderConfig, ProviderModelMappings } from "@/types";
import { automationModelOptions } from "./modelOptions";

const emptyMappings = (): ProviderModelMappings => ({
  anthropicModel: "",
  defaultOpusModel: "",
  defaultSonnetModel: "",
  defaultHaikuModel: "",
  subagent: "",
});

function makeProvider(
  id: string,
  model: string,
  knownModels: string[],
  mappings: ProviderModelMappings = emptyMappings(),
): ProviderConfig {
  return {
    id,
    kind: id === "__system_default__" ? "system_default" : "custom",
    name: id,
    icon: "provider",
    baseUrl: "",
    apiKeyConfigured: false,
    authTokenConfigured: false,
    model,
    modelMappings: mappings,
    effortLevel: "",
    autoCompactWindow: "",
    autocompactPctOverride: "",
    maxContextTokens: "",
    knownModels,
  };
}

/** 直接摆供应商模块级单例（与 ChatPanel.test.ts 同款——真实链路，不 mock 仓库）。 */
function setProviders(list: ProviderConfig[], activeId: string): void {
  const prov = useProviders();
  prov.__resetForTest();
  prov.allProviders.value = list;
  prov.activeProviderId.value = activeId;
}

const values = (current: string): string[] => automationModelOptions(current).map((o) => o.value);

describe("自动化模型下拉 = 当前供应商的模型列表", () => {
  beforeEach(() => setProviders([], "__system_default__"));

  it("系统默认供应商：给 CLI 别名（catalog 预设），不给写死的 Claude 名单", () => {
    setProviders(
      [makeProvider("__system_default__", "", ["opus", "sonnet", "haiku", "fable"])],
      "__system_default__",
    );

    expect(values("")).toEqual(["", "opus", "sonnet", "haiku", "fable"]);
    expect(values("")).not.toContain("claude-sonnet-5"); // ← 曾经的写死项
    expect(values("")).not.toContain("claude-opus-5");
    expect(values("")).not.toContain("claude-fable-5");
  });

  it("第三方供应商：顶层 model + 模型变量映射 + knownModels 全进列表且去重", () => {
    setProviders(
      [
        makeProvider("p_kimi", "kimi", ["kimi", "k2"], {
          ...emptyMappings(),
          defaultSonnetModel: "kimi-k2",
        }),
      ],
      "p_kimi",
    );

    expect(values("")).toEqual(["", "kimi", "kimi-k2", "k2"]);
  });

  it("跟随供应商的是**活动**供应商，不是列表里的第一个", () => {
    setProviders(
      [makeProvider("__system_default__", "", ["opus"]), makeProvider("p_other", "other-model", [])],
      "p_other",
    );

    expect(values("")).toEqual(["", "other-model"]);
  });

  it("首项恒为「跟随提供商默认」（空值 = 不下发 ANTHROPIC_MODEL）", () => {
    setProviders([makeProvider("__system_default__", "", ["opus"])], "__system_default__");

    const opts = automationModelOptions("opus");
    expect(opts[0]).toEqual({ value: "", label: "跟随提供商默认" });
  });

  it("旧任务的值已不在当前供应商列表里：原样保留一项，不静默改写", () => {
    setProviders([makeProvider("__system_default__", "", ["opus", "sonnet"])], "__system_default__");

    expect(values("claude-sonnet-5")).toEqual(["", "opus", "sonnet", "claude-sonnet-5"]);
  });

  it("值在列表里就不重复追加", () => {
    setProviders([makeProvider("__system_default__", "", ["opus", "sonnet"])], "__system_default__");

    expect(values("sonnet")).toEqual(["", "opus", "sonnet"]);
  });

  it("供应商还没加载（列表为空）：只剩「跟随提供商默认」，不崩不臆造", () => {
    expect(values("")).toEqual([""]);
  });
});
