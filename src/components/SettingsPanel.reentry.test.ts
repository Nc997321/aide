// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { ref, reactive } from "vue";
import type { VueWrapper } from "@vue/test-utils";

const updateFn = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const openFn = vi.hoisted(() => vi.fn());

vi.mock("../composables/useSettings", () => ({
  useSettings: () => ({
    settings: reactive({
      onboarded: true, theme: "warm-dark", fontSize: 14, fontFamily: "", proxy: "",
      recentLimit: 10,
      editor: { indentSize: 4, vimMode: false, vimKeybindings: { normal: [], insert: [], visual: [] } },
      codegraphEmbedder: { apiKeyConfigured: false, backend: "fastembed", baseUrl: "", dim: 768, model: "", format: "ollama" },
      remote: { relayUrl: "", permissionMode: "auto" },
      jdkRegistries: [], openWithExtensions: {},
    }),
    loaded: ref(true),
    update: updateFn,
    setCodegraphEmbedder: vi.fn().mockResolvedValue(undefined),
    setJdkRegistry: vi.fn().mockResolvedValue(undefined),
    dismissJdkPrompt: vi.fn(),
  }),
}));
vi.mock("../composables/useOnboarding", () => ({
  useOnboarding: () => ({ open: openFn }),
}));
vi.mock("../composables/useCustomizations", () => ({
  useCustomizations: () => ({
    activeType: ref(null), activeItemId: ref(null), editingItem: ref(null), loading: ref(false),
    loadAll: vi.fn().mockResolvedValue(undefined), selectCategory: vi.fn(), selectItem: vi.fn(), clearSelection: vi.fn(),
    createItem: vi.fn().mockResolvedValue(undefined), updateItem: vi.fn().mockResolvedValue(undefined),
    deleteItem: vi.fn().mockResolvedValue(undefined), toggleItem: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("../api", () => ({ api: new Proxy({}, { get: () => vi.fn().mockResolvedValue(undefined) }) }));

import SettingsPanel from "./SettingsPanel.vue";

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = "";
  updateFn.mockClear();
  openFn.mockClear();
});

function mountAbout() {
  wrapper = shallowMount(SettingsPanel, {
    props: { initialTab: "about" },
    attachTo: document.body,
    global: { stubs: { Teleport: false } },
  });
  return wrapper;
}

describe("SettingsPanel 重新运行首次引导", () => {
  it("关于 tab 渲染「重新运行首次引导」按钮", () => {
    mountAbout();
    expect(document.body.querySelector(".rerun-onboarding")).not.toBeNull();
  });

  it("点击 → update({onboarded:false}) + onboarding.open() + emit close", async () => {
    const w = mountAbout();
    const btn = document.body.querySelector(".rerun-onboarding") as HTMLButtonElement;
    btn.click();
    await Promise.resolve();
    expect(updateFn).toHaveBeenCalledWith({ onboarded: false });
    expect(openFn).toHaveBeenCalled();
    expect(w.emitted("close")).toBeTruthy();
  });
});