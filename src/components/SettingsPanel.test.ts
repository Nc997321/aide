// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import { ref, reactive } from "vue";
import type { VueWrapper } from "@vue/test-utils";
import SettingsPanel from "./SettingsPanel.vue";

vi.mock("../composables/useSettings", () => ({
  useSettings: () => ({
    settings: reactive({
      theme: "warm-dark", fontSize: 14, fontFamily: "", proxy: "",
      autoNaming: true, recentLimit: 10,
      editor: { indentSize: 4 },
      codegraphEmbedder: {
        apiKeyConfigured: false, backend: "fastembed", baseUrl: "",
        dim: 768, model: "", format: "ollama",
      },
      jdkRegistries: [], openWithExtensions: {},
    }),
    loaded: ref(true),
    update: vi.fn().mockResolvedValue(undefined),
    setCodegraphEmbedder: vi.fn().mockResolvedValue(undefined),
    setJdkRegistry: vi.fn().mockResolvedValue(undefined),
    dismissJdkPrompt: vi.fn(),
  }),
}));
vi.mock("../composables/useCustomizations", () => ({
  useCustomizations: () => ({
    activeType: ref(null),
    activeItemId: ref(null),
    editingItem: ref(null),
    loading: ref(false),
    loadAll: vi.fn().mockResolvedValue(undefined),
    selectCategory: vi.fn(),
    selectItem: vi.fn(),
    clearSelection: vi.fn(),
    createItem: vi.fn().mockResolvedValue(undefined),
    updateItem: vi.fn().mockResolvedValue(undefined),
    deleteItem: vi.fn().mockResolvedValue(undefined),
    toggleItem: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("../api", () => ({
  api: new Proxy(
    {},
    { get: () => vi.fn().mockResolvedValue(undefined) },
  ),
}));

let wrapper: VueWrapper | undefined;
afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = "";
});

// The dialog teleports to body; initialTab="permissions" avoids rendering the
// heavy general tab. The nav bar is always rendered regardless of active tab.
function mountPanel() {
  wrapper = shallowMount(SettingsPanel, {
    props: { initialTab: "permissions" },
    attachTo: document.body,
    // SettingsPanel roots in <Teleport to="body">. shallowMount stubs Teleport
    // by default, which would keep nav + content out of document.body and make
    // the assertions below read empty. Disable that one stub so Teleport renders
    // for real while child components (PermissionsSettings etc.) stay stubbed.
    global: { stubs: { Teleport: false } },
  });
  return wrapper;
}

describe("SettingsPanel", () => {
  it("places the Permissions tab between Model and Extensions (fixed order)", () => {
    mountPanel();
    const labels = Array.from(document.body.querySelectorAll(".nav-label")).map(
      (el) => el.textContent?.trim() ?? "",
    );
    // 工作区 tab 已移除（LSP 设置搬到标题栏 LspIndicator）；编辑器 tab 在通用之后
    expect(labels).toEqual([
      "通用", "编辑器", "模型", "权限", "扩展", "市场", "代码索引", "Java", "诊断",
    ]);
  });

  it("renders PermissionsSettings when the permissions tab is active", () => {
    mountPanel();
    // shallowMount stubs the child as <permissions-settings-stub>; the stub tag
    // appears in the teleported DOM (kebab-case + -stub suffix, hence the dashes).
    expect(document.body.innerHTML.toLowerCase()).toContain("permissions-settings-stub");
  });
});