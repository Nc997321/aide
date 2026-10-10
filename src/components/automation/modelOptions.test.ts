// 自动化编辑器的「供应商 → 模型」级联：一级是全部供应商、二级是该供应商的模型列表
// （与聊天面板同源），不是一份写死的 Claude 名单；默认停在当前激活供应商。
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
import {
  automationProviderGroups,
  automationSelectionLabel,
  effectiveProviderId,
} from "./modelOptions";

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

/** 某个供应商二级菜单里的模型值 */
function modelsOf(pid: string, current = { providerId: "", model: "" }): string[] {
  const g = automationProviderGroups(current).find((x) => x.id === pid);
  return g ? g.models.map((o) => o.value) : [];
}

describe("自动化模型选择 = 供应商 → 模型级联", () => {
  beforeEach(() => setProviders([], "__system_default__"));

  it("一级列出全部供应商（系统默认置首），不只当前激活的那个", () => {
    setProviders(
      [makeProvider("p_ollama", "qwen3", []), makeProvider("__system_default__", "", ["opus"])],
      "p_ollama",
    );

    expect(automationProviderGroups({ providerId: "", model: "" }).map((g) => g.id)).toEqual([
      "__system_default__",
      "p_ollama",
    ]);
  });

  it("系统默认供应商：给 CLI 别名（catalog 预设），不给写死的 Claude 名单", () => {
    setProviders(
      [makeProvider("__system_default__", "", ["opus", "sonnet", "haiku", "fable"])],
      "__system_default__",
    );

    const models = modelsOf("__system_default__");
    expect(models).toEqual(["", "opus", "sonnet", "haiku", "fable"]);
    expect(models).not.toContain("claude-sonnet-5"); // ← 曾经的写死项
    expect(models).not.toContain("claude-opus-5");
    expect(models).not.toContain("claude-fable-5");
  });

  it("第三方供应商：顶层 model + 模型变量映射 + knownModels 全进二级且去重", () => {
    setProviders(
      [
        makeProvider("p_kimi", "kimi", ["kimi", "k2"], {
          ...emptyMappings(),
          defaultSonnetModel: "kimi-k2",
        }),
      ],
      "p_kimi",
    );

    expect(modelsOf("p_kimi")).toEqual(["", "kimi", "kimi-k2", "k2"]);
  });

  it("二级首项恒为「默认模型」（空值 = 不覆盖 ANTHROPIC_MODEL），带上供应商配置的默认名", () => {
    setProviders(
      [makeProvider("__system_default__", "", ["opus"]), makeProvider("p_ollama", "qwen3", [])],
      "__system_default__",
    );

    const groups = automationProviderGroups({ providerId: "", model: "" });
    expect(groups[0].models[0]).toEqual({ value: "", label: "默认模型" });
    expect(groups[1].models[0]).toEqual({ value: "", label: "默认模型（qwen3）" });
  });

  it("没钉过供应商（新任务 / 存量任务）：默认就是当前激活供应商，显示它的名字", () => {
    setProviders(
      [makeProvider("__system_default__", "", ["opus"]), makeProvider("ollama", "", ["qwen3"])],
      "ollama",
    );

    expect(effectiveProviderId("")).toBe("ollama");
    expect(automationSelectionLabel({ providerId: "", model: "" })).toBe("ollama");
    expect(automationSelectionLabel({ providerId: "", model: "qwen3" })).toBe("ollama · qwen3");
  });

  it("任务钉了供应商：不随全局激活供应商漂移", () => {
    setProviders(
      [makeProvider("__system_default__", "", ["opus"]), makeProvider("ollama", "", ["qwen3"])],
      "__system_default__",
    );

    expect(effectiveProviderId("ollama")).toBe("ollama");
    expect(automationSelectionLabel({ providerId: "ollama", model: "qwen3" })).toBe("ollama · qwen3");
  });

  it("旧任务的模型已不在它供应商的列表里：原样保留一项，且只进它自己那一组", () => {
    setProviders(
      [makeProvider("__system_default__", "", ["opus", "sonnet"]), makeProvider("ollama", "", ["qwen3"])],
      "__system_default__",
    );
    const current = { providerId: "", model: "claude-sonnet-5" };

    expect(modelsOf("__system_default__", current)).toEqual(["", "opus", "sonnet", "claude-sonnet-5"]);
    expect(modelsOf("ollama", current)).toEqual(["", "qwen3"]);
  });

  it("值在列表里就不重复追加", () => {
    setProviders([makeProvider("__system_default__", "", ["opus", "sonnet"])], "__system_default__");

    expect(modelsOf("__system_default__", { providerId: "", model: "sonnet" })).toEqual(["", "opus", "sonnet"]);
  });

  it("任务钉的供应商已被删除：如实标出，不冒充别家", () => {
    setProviders([makeProvider("__system_default__", "", ["opus"])], "__system_default__");

    expect(automationSelectionLabel({ providerId: "p_gone", model: "kimi" })).toBe("供应商已删除 · kimi");
  });

  it("供应商还没加载（列表为空）：没有可选项，不崩不臆造", () => {
    expect(automationProviderGroups({ providerId: "", model: "" })).toEqual([]);
    expect(automationSelectionLabel({ providerId: "", model: "" })).toBe("");
  });
});
