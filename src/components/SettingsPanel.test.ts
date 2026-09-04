// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { ref, reactive } from "vue";
import type { VueWrapper } from "@vue/test-utils";
import SettingsPanel from "./SettingsPanel.vue";

const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));
vi.mock("../composables/useSettings", () => ({
  useSettings: () => ({
    settings: reactive({
      theme: "warm-dark", fontSize: 14, fontFamily: "", proxy: "",
      recentLimit: 10,
      keybindings: {}, shellPath: "", workbenchHeight: 0,
      editor: { indentSize: 4, vimMode: false, vimKeybindings: { normal: [], insert: [], visual: [] } },
      codegraphEmbedder: {
        apiKeyConfigured: false, backend: "fastembed", baseUrl: "",
        dim: 768, model: "", format: "ollama",
      },
      remote: { enabled: false, relayUrl: "", deviceId: "", permissionMode: "auto" },
      jdkRegistries: [], openWithExtensions: {},
    }),
    loaded: ref(true),
    update: updateMock,
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
vi.mock("../api", () => {
  // 按方法名缓存 mock fn——否则每次属性访问都生成新 fn，测试里无法覆写返回值。
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  return {
    api: new Proxy(
      {},
      {
        get: (_t, key) => {
          const k = String(key);
          if (!fns.has(k)) fns.set(k, vi.fn().mockResolvedValue(undefined));
          return fns.get(k);
        },
      },
    ),
  };
});
import { api } from "../api";

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
    // 主题样式 tab 于 2026-08-25 加在通用之后（主题切换 + 会话列表样式，主题从通用搬入）。
    // 代码索引 tab 于 2026-08-31 迁出（工作区级开关下沉右侧栏「代码索引」tab）。
    // 市场 tab 于 2026-09-03 迁出：插件市场成为一级主区视图，入口在左侧栏「插件」。
    expect(labels).toEqual([
      "通用", "主题样式", "编辑器", "模型", "扩展", "诊断", "远程控制", "关于",
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

  it("offers one-click apply when a live proxy is detected and settings empty", async () => {
    vi.mocked(api.detectAvailableProxy).mockResolvedValue("http://127.0.0.1:7890");
    mountPanel("general");
    await flushPromises();

    const hint = document.body.querySelector(".proxy-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("http://127.0.0.1:7890");

    // 点「应用」→ 填入输入框，提示消失
    (hint!.querySelector("button") as HTMLButtonElement).click();
    await flushPromises();

    const input = document.body.querySelector<HTMLInputElement>(
      "input[placeholder*='127.0.0.1']",
    );
    expect(input!.value).toBe("http://127.0.0.1:7890");
    expect(document.body.querySelector(".proxy-hint")).toBeNull();
  });

  it("hides proxy hint once dismissed", async () => {
    vi.mocked(api.detectAvailableProxy).mockResolvedValue("http://127.0.0.1:7890");
    mountPanel("general");
    await flushPromises();

    const hint = document.body.querySelector(".proxy-hint");
    expect(hint).not.toBeNull();
    // 「忽略」→ 提示消失，输入框保持为空
    const buttons = hint!.querySelectorAll("button");
    (buttons[buttons.length - 1] as HTMLButtonElement).click();
    await flushPromises();

    expect(document.body.querySelector(".proxy-hint")).toBeNull();
    const input = document.body.querySelector<HTMLInputElement>(
      "input[placeholder*='127.0.0.1']",
    );
    expect(input!.value).toBe("");
  });

  it("editor tab renders vim toggle and writes editor block on change", async () => {
    mountPanel("editor");
    await flushPromises();

    const toggle = document.body.querySelector<HTMLInputElement>(
      ".tab-editor .toggle input[type=checkbox]",
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.checked).toBe(false);

    toggle!.click();
    await flushPromises();

    // 整块写入：update 收到完整 editor 对象（含 vimMode: true 与既有 indentSize/vimKeybindings）
    expect(updateMock).toHaveBeenCalledWith({
      editor: {
        indentSize: 4,
        vimMode: true,
        vimKeybindings: { normal: [], insert: [], visual: [] },
      },
    });
  });
});