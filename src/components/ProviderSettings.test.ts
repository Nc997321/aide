// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import type { ProviderConfig } from "@aide/sdk/types";

vi.mock("../composables/useProviders", async () => {
  const { ref } = await import("vue");
  const allProviders = ref<ProviderConfig[]>([]);
  const state = {
    allProviders, displayList: allProviders, activeProviderId: ref("p"),
    load: vi.fn(async () => {}), updateProvider: vi.fn(async () => {}),
    deleteProvider: vi.fn(), setActiveProvider: vi.fn(), addPresetProvider: vi.fn(), addProvider: vi.fn(),
    SYSTEM_DEFAULT_ID: "__system_default__",
  };
  return { useProviders: () => state };
});
vi.mock("../composables/useProviderCatalog", () => ({
  useProviderCatalog: () => ({
    presetForKind: () => undefined, enrichForDisplay: (provider: ProviderConfig) => provider,
    loadCatalog: async () => {},
  }),
}));
vi.mock("../composables/useToast", () => ({
  useToast: () => ({ toastState: { visible: false, text: "", kind: "info" }, showToast: vi.fn() }),
}));
vi.mock("../composables/useModal", () => ({ useModal: () => ({ confirm: vi.fn() }) }));
vi.mock("@aide/sdk", () => ({ hostApi: { current: async () => ({ key: "local" }) } }));

import ProviderSettings from "./ProviderSettings.vue";
import ThemedSelect from "./ThemedSelect.vue";
import { useProviders } from "../composables/useProviders";

enableAutoUnmount(afterEach);
const providers = useProviders();
function provider(): ProviderConfig {
  return {
    id: "p", kind: "custom", name: "Test provider", icon: "provider", baseUrl: "",
    apiKeyConfigured: false, authTokenConfigured: false, model: "",
    modelMappings: {
      anthropicModel: "legacy[1m]", defaultOpusModel: "main", defaultFableModel: "deep",
      defaultSonnetModel: "main", defaultHaikuModel: "fast", subagent: "fast",
    },
    knownModels: [], effortLevel: "", autoCompactWindow: "", autocompactPctOverride: "", maxContextTokens: "",
  };
}

async function mountProvider() {
  const wrapper = mount(ProviderSettings, {
    global: {
      stubs: { ProviderActions: true, ProviderCatalogPicker: true, ProviderLogo: true, ClaudeAccountLogin: true, Icon: true, AToast: true },
      directives: { tooltip: {} },
    },
  });
  const item = wrapper.findAll(".provider-item")[1];
  if (!item) throw new Error("missing provider item");
  await item.trigger("click");
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  const p = provider();
  providers.allProviders.value = [
    { ...p, id: "__system_default__", kind: "system_default", name: "Anthropic" }, p,
  ];
  vi.mocked(providers.updateProvider).mockClear();
});

describe("供应商模型设置", () => {
  it("默认模型为去重下拉，保留旧独立默认；选择只改草稿，保存才落盘", async () => {
    const wrapper = await mountProvider();
    const select = wrapper.findAllComponents(ThemedSelect).find((item) => item.props("title") === "默认模型");
    if (!select) throw new Error("missing default model select");
    expect(select.props("options")).toEqual([
      { value: "", label: "使用供应商默认" },
      { value: "legacy[1m]", label: "legacy[1m]" },
      { value: "main", label: "main" },
      { value: "deep", label: "deep" },
      { value: "fast", label: "fast" },
    ]);
    expect(select.props("modelValue")).toBe("legacy[1m]");
    select.vm.$emit("update:modelValue", "deep");
    await flushPromises();
    expect(providers.allProviders.value[1]?.modelMappings.anthropicModel).toBe("legacy[1m]");
    expect(providers.updateProvider).not.toHaveBeenCalled();
    await wrapper.get(".btn-save").trigger("click");
    expect(providers.updateProvider).toHaveBeenCalledWith("p", expect.objectContaining({
      modelMappings: expect.objectContaining({ anthropicModel: "deep", defaultFableModel: "deep" }),
    }), expect.anything());
  });

  it("Fable 排在 Opus 前，输入进入默认模型候选但不立即写供应商 store", async () => {
    const wrapper = await mountProvider();
    expect(wrapper.findAll(".model-var-field").slice(0, 6).map((item) => item.get("label").text())).toEqual([
      "默认模型", "最强模型（Fable）", "旗舰模型（Opus）", "均衡模型（Sonnet）", "轻量模型（Haiku）", "子代理模型",
    ]);
    const field = wrapper.findAll(".model-var-field").find((item) => item.find("label").text() === "最强模型（Fable）");
    if (!field) throw new Error("missing Fable mapping input");
    await field.get("input").setValue("new-deep");
    const select = wrapper.findAllComponents(ThemedSelect).find((item) => item.props("title") === "默认模型");
    expect(select?.props("options")).toContainEqual({ value: "new-deep", label: "new-deep" });
    expect(providers.allProviders.value[1]?.modelMappings.defaultFableModel).toBe("deep");
    expect(providers.updateProvider).not.toHaveBeenCalled();
  });
});
