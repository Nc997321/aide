// @vitest-environment jsdom
// vim 键位映射快捷目标 chip（SettingsPanel 编辑器 tab）：点击把目标填到该模式
// 最后一行。两个分支：无行时自动加一行；已有行直接填。settings 经 globalThis
// 桥接供 beforeEach 重置（mock 工厂闭包内创建、测试需访问）。
import { describe, it, test, expect, vi, afterEach, beforeEach } from "vitest";
import { shallowMount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { VueWrapper } from "@vue/test-utils";
import type { VimBindings } from "../types";

const updateMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../composables/useSettings", () => {
  // 工厂闭包内创建 settings；挂 globalThis 供测试 beforeEach 重置
  const { reactive } = require("vue") as typeof import("vue");
  const settings = reactive({
    onboarded: true, theme: "warm-dark", fontSize: 14, fontFamily: "", proxy: "",
    recentLimit: 10,
    editor: {
      indentSize: 4, vimMode: true,
      vimKeybindings: { normal: [], insert: [], visual: [] } as VimBindings,
    },
    codegraphEmbedder: {
      apiKeyConfigured: false, backend: "fastembed", baseUrl: "",
      dim: 768, model: "", format: "ollama",
    },
    remote: { relayUrl: "", permissionMode: "auto" },
    jdkRegistries: [], openWithExtensions: {},
  });
  (globalThis as { __vimSettings?: typeof settings }).__vimSettings = settings;
  return {
    useSettings: () => ({
      settings,
      loaded: ref(true),
      update: updateMock,
      setCodegraphEmbedder: vi.fn().mockResolvedValue(undefined),
      setJdkRegistry: vi.fn().mockResolvedValue(undefined),
      dismissJdkPrompt: vi.fn(),
    }),
  };
});
vi.mock("../composables/useOnboarding", () => ({
  useOnboarding: () => ({ open: vi.fn() }),
}));
vi.mock("../composables/useCustomizations", () => ({
  useCustomizations: () => ({
    activeType: ref(null), activeItemId: ref(null), editingItem: ref(null), loading: ref(false),
    loadAll: vi.fn().mockResolvedValue(undefined), selectCategory: vi.fn(), selectItem: vi.fn(),
    clearSelection: vi.fn(), createItem: vi.fn().mockResolvedValue(undefined),
    updateItem: vi.fn().mockResolvedValue(undefined), deleteItem: vi.fn().mockResolvedValue(undefined),
    toggleItem: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("../api", () => ({ api: new Proxy({}, { get: () => vi.fn().mockResolvedValue(undefined) }) }));

import SettingsPanel from "./SettingsPanel.vue";

let wrapper: VueWrapper | undefined;

function testSettings(): { editor: { vimKeybindings: VimBindings } } {
  const s = (globalThis as { __vimSettings?: never }).__vimSettings;
  if (!s) throw new Error("mock settings not wired");
  return s;
}

function mountEditorTab() {
  wrapper = shallowMount(SettingsPanel, {
    props: { initialTab: "editor" },
    attachTo: document.body,
    global: { stubs: { Teleport: false } },
  });
  return wrapper;
}

function targetInputs(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll<HTMLInputElement>(".vim-key-target"));
}

beforeEach(() => {
  testSettings().editor.vimKeybindings = { normal: [], insert: [], visual: [] };
  updateMock.mockClear();
});

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = "";
});

describe("SettingsPanel vim key recording lifecycle", () => {
  function pressWindowKey(key: string, init: KeyboardEventInit = {}) {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  }

  it("record_captures_key_then_stops_listening", async () => {
    mountEditorTab();
    await flushPromises();
    const add = document.body.querySelector(".vim-key-add") as HTMLButtonElement;
    add.click();
    await flushPromises();

    const rec = document.body.querySelector(".vim-key-rec") as HTMLButtonElement;
    rec.click();
    await flushPromises();
    expect(document.body.querySelector(".vim-recording-banner")).not.toBeNull();

    // 用户最初的映射：Ctrl+[ → 录制捕获 <C-[>
    pressWindowKey("[", { ctrlKey: true });
    await flushPromises();
    expect(testSettings().editor.vimKeybindings.normal[0].keys).toBe("<C-[>");
    expect(document.body.querySelector(".vim-recording-banner")).toBeNull();

    // 录制结束后再按键 → 不写 keys（回归：监听泄漏吞键/覆写）
    pressWindowKey("a");
    await flushPromises();
    expect(testSettings().editor.vimKeybindings.normal[0].keys).toBe("<C-[>");
  });

  it("record_toggle_cancels_and_unhooks", async () => {
    mountEditorTab();
    await flushPromises();
    const add = document.body.querySelector(".vim-key-add") as HTMLButtonElement;
    add.click();
    await flushPromises();

    const rec = document.body.querySelector(".vim-key-rec") as HTMLButtonElement;
    rec.click();
    await flushPromises();
    expect(document.body.querySelector(".vim-recording-banner")).not.toBeNull();

    // 再点同一行 = 取消（录制挂起会吞键，必须可逆）
    rec.click();
    await flushPromises();
    expect(document.body.querySelector(".vim-recording-banner")).toBeNull();

    pressWindowKey("a");
    await flushPromises();
    expect(testSettings().editor.vimKeybindings.normal[0].keys).toBe("");
  });

  test("record_auto_cancels_after_30s_timeout", async () => {
    vi.useFakeTimers();
    try {
      mountEditorTab();
      await vi.advanceTimersByTimeAsync(0);
      const add = document.body.querySelector(".vim-key-add") as HTMLButtonElement;
      add.click();
      await vi.advanceTimersByTimeAsync(0);
      const rec = document.body.querySelector(".vim-key-rec") as HTMLButtonElement;
      rec.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.body.querySelector(".vim-recording-banner")).not.toBeNull();

      // 30s 无按键 → 自动取消（防挂起监听吞后续所有按键）
      await vi.advanceTimersByTimeAsync(30_000);
      expect(document.body.querySelector(".vim-recording-banner")).toBeNull();

      pressWindowKey("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(testSettings().editor.vimKeybindings.normal[0].keys).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("record_state_cleared_when_row_deleted", async () => {
    mountEditorTab();
    await flushPromises();
    const add = document.body.querySelector(".vim-key-add") as HTMLButtonElement;
    add.click();
    await flushPromises();

    const rec = document.body.querySelector(".vim-key-rec") as HTMLButtonElement;
    rec.click();
    await flushPromises();
    expect(document.body.querySelector(".vim-recording-banner")).not.toBeNull();

    const del = document.body.querySelector(".vim-key-del") as HTMLButtonElement;
    del.click();
    await flushPromises();
    expect(document.body.querySelector(".vim-recording-banner")).toBeNull();
    expect(testSettings().editor.vimKeybindings.normal).toHaveLength(0);
  });
});

describe("SettingsPanel vim keymap suggestion chips", () => {
  it("chip_with_no_rows_adds_row_and_fills", async () => {
    mountEditorTab();
    await flushPromises();
    expect(targetInputs()).toHaveLength(0);

    const chip = document.body.querySelector(".vim-key-suggest") as HTMLButtonElement;
    expect(chip.textContent).toBe("<Esc>");
    chip.click();
    await flushPromises();

    expect(targetInputs()).toHaveLength(1);
    expect(targetInputs()[0].value).toBe("<Esc>");
    expect(updateMock).toHaveBeenCalledTimes(1); // persistVimBindings
  });

  it("click_with_existing_row_fills_last_row_without_adding", async () => {
    mountEditorTab();
    await flushPromises();

    // 先加两行，模拟用户已录制的状态
    const add = document.body.querySelector(".vim-key-add") as HTMLButtonElement;
    add.click();
    add.click();
    await flushPromises();
    expect(targetInputs()).toHaveLength(2);

    const qChip = Array.from(document.body.querySelectorAll(".vim-key-suggest"))
      .find((b) => b.textContent === ":wq") as HTMLButtonElement;
    qChip.click();
    await flushPromises();

    expect(targetInputs()).toHaveLength(2); // 未新增行
    expect(targetInputs()[1].value).toBe(":wq");
  });

  it("chip_target_is_optional_hint_input_still_editable", async () => {
    // 快捷 chip 只是便捷：target 输入框仍可手输任意 vim 键序列
    mountEditorTab();
    await flushPromises();
    const add = document.body.querySelector(".vim-key-add") as HTMLButtonElement;
    add.click();
    await flushPromises();
    const input = targetInputs()[0];
    input.value = "dd";
    input.dispatchEvent(new Event("input")); // v-model 监听 input 事件
    await flushPromises();
    expect(testSettings().editor.vimKeybindings.normal[0].to).toBe("dd");
  });
});
