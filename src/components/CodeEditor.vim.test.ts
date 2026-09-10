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
      callHierarchyProvider: false,
      inlayHintProvider: false,
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

// 编辑器右键菜单的复制/剪切/粘贴/全选：剪贴板用 Web API（stub 掉），文档改动走
// replaceSelection（dispatch）→ updateListener 判定用户编辑 → 回流 update:modelValue。
describe("CodeEditor 剪贴板动作", () => {
  const clipboard = {
    written: [] as string[],
    pendingRead: "" as string,
    writeText: (t: string) => {
      clipboard.written.push(t);
      return Promise.resolve();
    },
    readText: () => Promise.resolve(clipboard.pendingRead),
  };

  beforeEach(() => {
    clipboard.written = [];
    clipboard.pendingRead = "";
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: clipboard.writeText, readText: clipboard.readText },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function mountWithText(text: string) {
    wrapper = mount(CodeEditor, {
      props: { filePath: "/p/a.ts", modelValue: text },
      attachTo: document.body,
    });
    await flushPromises();
    return (await getView())!;
  }

  function selectLines(v: EditorView, start: number, end: number) {
    v.dispatch({
      selection: { anchor: v.state.doc.line(start).from, head: v.state.doc.line(end).to },
    });
  }

  it("复制：选中内容进剪贴板，文档不变", async () => {
    const v = await mountWithText("L1\nL2\nL3");
    selectLines(v, 2, 2);
    await wrapper!.vm.copySelection();
    expect(clipboard.written).toEqual(["L2"]);
    expect(v.state.doc.toString()).toBe("L1\nL2\nL3");
  });

  it("剪切：内容进剪贴板且从文档移除（v-model 回流）", async () => {
    const v = await mountWithText("L1\nL2\nL3");
    selectLines(v, 2, 2);
    await wrapper!.vm.cutSelection();
    expect(clipboard.written).toEqual(["L2"]);
    expect(v.state.doc.toString()).toBe("L1\n\nL3");
    expect(wrapper!.emitted("update:modelValue")?.at(-1)?.[0]).toBe("L1\n\nL3");
  });

  it("粘贴：替换选区并回流 v-model", async () => {
    const v = await mountWithText("L1\nL2\nL3");
    selectLines(v, 2, 2);
    clipboard.pendingRead = "PASTED";
    await wrapper!.vm.pasteFromClipboard();
    expect(v.state.doc.toString()).toBe("L1\nPASTED\nL3");
    expect(wrapper!.emitted("update:modelValue")?.at(-1)?.[0]).toBe("L1\nPASTED\nL3");
  });

  it("粘贴：无选区时光标处插入，不覆盖", async () => {
    const v = await mountWithText("ab");
    v.dispatch({ selection: { anchor: 1, head: 1 } });
    clipboard.pendingRead = "X";
    await wrapper!.vm.pasteFromClipboard();
    expect(v.state.doc.toString()).toBe("aXb");
  });

  it("全选：选区覆盖整篇文档", async () => {
    const v = await mountWithText("L1\nL2\nL3");
    wrapper!.vm.selectAll();
    const { from, to } = v.state.selection.main;
    expect(from).toBe(0);
    expect(to).toBe(v.state.doc.length);
  });

  it("无选区时复制/剪切是空操作（菜单已置灰，这里只保证不误改文档）", async () => {
    const v = await mountWithText("L1\nL2");
    await wrapper!.vm.copySelection();
    await wrapper!.vm.cutSelection();
    expect(clipboard.written).toEqual([]);
    expect(v.state.doc.toString()).toBe("L1\nL2");
  });
});

// 「添加选中到对话」取行号区间（1-based 闭区间）：空选区 = 没选东西（null），
// 选区止于行尾换行时不多算一行——否则选中一行会报成两行。
describe("CodeEditor selectionLines", () => {
  async function mountWithText(text: string) {
    wrapper = mount(CodeEditor, {
      props: { filePath: "/p/a.ts", modelValue: text },
      attachTo: document.body,
    });
    await flushPromises();
    return (await getView())!;
  }

  function selectRange(v: EditorView, fromLine: number, fromOffset: number, toLine: number, toOffset: number) {
    v.dispatch({
      selection: {
        anchor: v.state.doc.line(fromLine).from + fromOffset,
        head: v.state.doc.line(toLine).from + toOffset,
      },
    });
  }

  it("空选区返回 null（不是「选了零行」）", async () => {
    const v = await mountWithText("L1\nL2\nL3");
    selectRange(v, 2, 0, 2, 0);
    expect(wrapper!.vm.selectionLines()).toBeNull();
  });

  it("跨行选区返回起止行号", async () => {
    const v = await mountWithText("L1\nL2\nL3\nL4\nL5");
    selectRange(v, 2, 0, 4, 2); // 第 2 行行首 → 第 4 行中间
    expect(wrapper!.vm.selectionLines()).toEqual({ start: 2, end: 4 });
  });

  it("选区止于行尾换行（head 落在下一行行首）不多算一行", async () => {
    const v = await mountWithText("L1\nL2\nL3");
    // 整行选中时 CM 的 head 落在下一行行首——仍应报 2-2，不是 2-3
    selectRange(v, 2, 0, 3, 0);
    expect(wrapper!.vm.selectionLines()).toEqual({ start: 2, end: 2 });
  });

  it("行内部分选中仍算该行", async () => {
    const v = await mountWithText("L1\nL2 abc\nL3");
    selectRange(v, 2, 1, 2, 3);
    expect(wrapper!.vm.selectionLines()).toEqual({ start: 2, end: 2 });
  });
});
