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
      remote: { enabled: false, relayUrl: "", deviceId: "", permissionMode: "auto" },
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

// The dialog teleports to body; initialTab="about" avoids rendering the
// heavy general tab. The nav bar is always rendered regardless of active tab.
function mountPanel(initialTab = "about") {
  wrapper = shallowMount(SettingsPanel, {
    props: { initialTab },
    attachTo: document.body,
    // SettingsPanel roots in <Teleport to="body">. shallowMount stubs Teleport
    // by default, which would keep nav + content out of document.body and make
    // the assertions below read empty. Disable that one stub so Teleport renders
    // for real while child components (DiagnosticsDashboard etc.) stay stubbed.
    global: { stubs: { Teleport: false } },
  });
  return wrapper;
}

describe("SettingsPanel", () => {
  it("renders the settings nav in fixed order (Permissions moved to right rail)", () => {
    mountPanel();
    const labels = Array.from(document.body.querySelectorAll(".nav-label")).map(
      (el) => el.textContent?.trim() ?? "",
    );
    // 工作区 tab 已移除（LSP 设置搬到标题栏 LspIndicator）；Java tab 亦于
    // 2026-08-08 搬走（JDK 管理迁入 LspIndicator 面板 JDK 区块，工作区级语义）。
    // 权限 tab 于 2026-08-16 迁入右侧 rail（工作区级语义，不再属于公共设置）。
    // 编辑器 tab 在通用之后；「关于」tab 固定在末尾（2026-08-09 新增，版本与声明）。
    // 远程控制 tab 于 2026-08-16 加在诊断之后、关于之前。
    expect(labels).toEqual([
      "通用", "编辑器", "模型", "扩展", "市场", "代码索引", "诊断", "远程控制", "关于",
    ]);
  });

  it("places the Remote tab after Diagnostics (fixed order)", () => {
    mountPanel();
    const labels = Array.from(document.body.querySelectorAll(".nav-label")).map(
      (el) => el.textContent?.trim() ?? "",
    );
    expect(labels[labels.length - 2]).toBe("远程控制");
    expect(labels[labels.length - 1]).toBe("关于");
  });

  it("renders remote tab with pairing code and status", async () => {
    mountPanel("remote");
    const text = document.body.textContent ?? "";
    expect(text).toContain("中继 URL");
    expect(text).toContain("配对码");
    expect(text).toContain("未连接");
  });
});