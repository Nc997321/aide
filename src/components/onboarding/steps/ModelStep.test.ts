// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

const getDefaultModels = vi.hoisted(() => ({ fn: vi.fn() }));
const providersMock = vi.hoisted(() => ({
  systemDefaultMappings: {
    value: { anthropicModel: "claude-sonnet-5", defaultOpusModel: "", defaultSonnetModel: "", defaultHaikuModel: "", subagent: "" },
  },
  saveSystemDefaultMappings: vi.fn(),
  refreshing: { value: false },
}));

vi.mock("../../../api", () => ({ api: { getDefaultModels: () => getDefaultModels.fn() } }));
vi.mock("../../../composables/useProviders", () => ({ useProviders: () => providersMock }));
vi.mock("../../ThemedSelect.vue", () => ({
  default: {
    name: "ThemedSelect",
    props: ["modelValue", "options", "block"],
    emits: ["update:modelValue"],
    template: '<div class="themed-select-stub"></div>',
  },
}));

import ModelStep from "./ModelStep.vue";

const flush = () => new Promise((r) => setTimeout(r, 0));
function mountStep() {
  return mount(ModelStep, { attachTo: document.body });
}

describe("ModelStep", () => {
  beforeEach(() => {
    getDefaultModels.fn.mockReset();
    providersMock.saveSystemDefaultMappings.mockReset();
    providersMock.systemDefaultMappings.value.anthropicModel = "claude-sonnet-5";
    providersMock.refreshing.value = false;
  });

  it("渲染当前模型名 + 供应商 hint", async () => {
    getDefaultModels.fn.mockResolvedValue([
      { value: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { value: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
    ]);
    const w = mountStep();
    await flush();
    expect(w.find(".model-pick .t").text()).toContain("Claude Sonnet 5");
    expect(w.find(".model-hint").text()).toContain("供应商");
  });

  it("anthropicModel 为空时回退第一个可用模型", async () => {
    providersMock.systemDefaultMappings.value.anthropicModel = "";
    getDefaultModels.fn.mockResolvedValue([
      { value: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ]);
    const w = mountStep();
    await flush();
    expect(w.find(".model-pick .t").text()).toContain("Claude Sonnet 5");
  });

  it("加载失败且无默认模型时显示「加载中…」、不崩", async () => {
    providersMock.systemDefaultMappings.value.anthropicModel = "";
    getDefaultModels.fn.mockRejectedValue(new Error("network"));
    const w = mountStep();
    await flush();
    expect(w.find(".model-pick .t").text()).toContain("加载中…");
  });

  it("refreshing=true（refreshModels 在飞）时显示「正在从 Anthropic 获取模型…」", async () => {
    providersMock.refreshing.value = true;
    getDefaultModels.fn.mockResolvedValue([
      { value: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    ]);
    const w = mountStep();
    await flush();
    expect(w.find(".model-pick .t").text()).toContain("正在从 Anthropic 获取模型");
  });
});