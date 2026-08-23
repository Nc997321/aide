// @vitest-environment jsdom
// vim 模式（@replit/codemirror-vim）装载/卸载/热切换测试。
// 断言信号：vimPlugin 在 view.scrollDOM 上加/移除 "cm-vimMode" 类
// （node_modules/@replit/codemirror-vim/dist/index.js:1410-1412）。
// jsdom 缺 Range.getClientRects，CM6 measure 阶段会崩（textRange(...).getClientRects
// is not a function）——polyfill 返回空数组，CM6 消费处 `if (!rects.length) return null`
// 走安全退化路径（光标测量为 null，不影响 doc/类断言）。
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function () {
    return [];
  };
}
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { reactive, ref } from "vue";
import { EditorView } from "@codemirror/view";
import CodeEditor from "./CodeEditor.vue";

// 模块级可变 settings：测试间共享，beforeEach 重置 vimMode
const settings = reactive({
  theme: "warm-dark",
  fontSize: 14,
  editorFontFamily: "monospace",
  editor: {
    indentSize: 4,
    vimMode: false,
    vimKeybindings: { normal: [], insert: [], visual: [] },
  },
});

vi.mock("../composables/useSettings", () => ({
  useSettings: () => ({ settings, loaded: ref(true), update: vi.fn() }),
}));
vi.mock("../composables/useModal", () => ({
  useModal: () => ({ prompt: vi.fn().mockResolvedValue(null) }),
}));
vi.mock("../composables/useLsp", () => ({
  useLsp: () => ({
    isLspOn: () => false,
    getCapabilities: vi.fn().mockResolvedValue({
      implementationProvider: false,
      documentSymbolProvider: false,
    }),
  }),
}));

let wrapper: VueWrapper | undefined;

// createEditor 是 async（动态 import 语言包），flushPromises 不够等——轮询等
// .cm-content 出现（探针实测：直接 querySelector 会拿到 null）。
async function waitForContent(): Promise<Element> {
  for (let i = 0; i < 20; i++) {
    const el = document.querySelector(".cm-content");
    if (el) return el;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("cm-content never appeared");
}

async function getView(): Promise<EditorView | null> {
  const content = await waitForContent();
  return EditorView.findFromDOM(content);
}

async function vimActive(): Promise<boolean> {
  const view = await getView();
  return view !== null && view.scrollDOM.classList.contains("cm-vimMode");
}

function pressKey(key: string): void {
  const content = document.querySelector(".cm-content");
  content?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

beforeEach(() => {
  settings.editor.vimMode = false;
});

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = "";
});

describe("CodeEditor vim mode", () => {
  function mountEditor() {
    return mount(CodeEditor, {
      props: { filePath: "/p/a.ts", modelValue: "hello" },
      // 挂到 document.body：document.querySelector 才能找到 .cm-content
      // （mount 默认 detached，querySelector 查不到）
      attachTo: document.body,
    });
  }

  it("vim_off_default_no_vim_extension", async () => {
    wrapper = mountEditor();
    await flushPromises();
    expect(await vimActive()).toBe(false);
  });

  it("vim_on_extension_loaded_and_normal_mode_works", async () => {
    settings.editor.vimMode = true;
    wrapper = mountEditor();
    await flushPromises();
    expect(await vimActive()).toBe(true);
    // normal 模式：x 删除光标处字符（doc "hello" → "ello"）
    pressKey("x");
    expect((await getView())?.state.doc.toString()).toBe("ello");
  });

  it("vim_normal_mode_i_enters_insert_and_input_event_does_not_bypass", async () => {
    // 真实按键链：keydown 被 vim 拦截（进 insert）后，浏览器不再产生 input；
    // 即便产生了，normal 模式的 input 也不该把字符塞进 doc。
    // 2026-08-24 实锤：第三方输入法把 keydown 截成 composition 组合流程，
    // vim 的 keydown 拦截链够不着 → 按键直接写入（用户实测，换系统输入法即好）。
    settings.editor.vimMode = true;
    wrapper = mountEditor();
    await flushPromises();
    const view = await getView();
    pressKey("i");
    expect(view?.state.doc.toString(), "i keydown must not insert").toBe("hello");
    // vim 已进 insert（normal 模式类消失）
    expect(view?.scrollDOM.classList.contains("cm-vimMode")).toBe(false);
    // 模拟浏览器 input 事件（keydown 未被拦截时才会产生）
    const content = document.querySelector(".cm-content");
    content?.dispatchEvent(
      new InputEvent("input", { data: "i", inputType: "insertText", bubbles: true }),
    );
    expect(view?.state.doc.toString()).toBe("hello");
  });

  // ex 命令端到端：: 进 vim 的 ex 输入（openDialog 渲染 .cm-vim-panel input），
  // 回车提交 → exCommandDispatcher → 我们 defineEx 注册的 w/wq/q → emit "vim-ex"。
  async function runExCommand(command: string) {
    pressKey(":");
    const input = document.querySelector<HTMLInputElement>(".cm-vim-panel input");
    if (!input) throw new Error("vim ex input not rendered");
    input.value = command;
    input.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 13, bubbles: true }));
  }

  it("vim_ex_w_saves", async () => {
    settings.editor.vimMode = true;
    wrapper = mountEditor();
    await flushPromises();
    await runExCommand("w");
    expect(wrapper?.emitted("vim-ex")).toEqual([["w"]]);
  });

  it("vim_ex_wq_save_and_close", async () => {
    settings.editor.vimMode = true;
    wrapper = mountEditor();
    await flushPromises();
    await runExCommand("wq");
    // :wq 走独立 "wq" 前缀注册（vim-core 最长前缀匹配，w 注册不吞 wq）
    expect(wrapper?.emitted("vim-ex")).toEqual([["wq"]]);
  });

  it("vim_ex_q_asks_close", async () => {
    settings.editor.vimMode = true;
    wrapper = mountEditor();
    await flushPromises();
    await runExCommand("q");
    expect(wrapper?.emitted("vim-ex")).toEqual([["q"]]);
  });

  it("vim_ex_q_bang_force_close", async () => {
    settings.editor.vimMode = true;
    wrapper = mountEditor();
    await flushPromises();
    // :q! 的 ! 不属 \w+ 命令名（留在 argString），q handler 收到 "q!"
    await runExCommand("q!");
    expect(wrapper?.emitted("vim-ex")).toEqual([["q!"]]);
  });

  it("vim_toggle_reconfigure_hot_switches", async () => {
    wrapper = mountEditor();
    await flushPromises();
    expect(await vimActive()).toBe(false);

    // 开：设置面板切 vimMode → watch reconfigure 装载 vim
    settings.editor.vimMode = true;
    await flushPromises();
    expect(await vimActive()).toBe(true);
    pressKey("x");
    expect((await getView())?.state.doc.toString()).toBe("ello");

    // 关：reconfigure 卸载 vim，normal 模式行为消失
    settings.editor.vimMode = false;
    await flushPromises();
    expect(await vimActive()).toBe(false);
  });
});
