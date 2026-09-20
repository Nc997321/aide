// @vitest-environment jsdom
/**
 * 重建守卫：`pair` 是父层每次重算都**新造的对象**（utils/changeCard.ts 的
 * buildChangeInfo），而视图重建一次 = 一次 `await loadLanguageExtension` +
 * 一次 MergeView 构造（真机 ~250ms；冻结报告里那串 `import.then` 长任务就是它）。
 * 所以：内容一字未变时**不许**重建。
 *
 * 断言信号用编辑器 DOM 节点的身份——重建必然换新节点，不需要 mock CodeMirror。
 *
 * jsdom 缺 Range.getClientRects，CM6 measure 会崩（同 CodeEditor.vim.test.ts）。
 */
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function () {
    return [];
  };
}
import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import DiffViewer from "./DiffViewer.vue";
import type { DiffPair } from "../../types";

const settings = ref({
  theme: "glass",
  fontSize: 13,
  editorFontFamily: "monospace",
});
vi.mock("../../composables/useSettings", () => ({
  useSettings: () => ({ settings: settings.value, loaded: ref(true), update: vi.fn() }),
}));

const basePair: DiffPair = {
  oldText: "const a = 1;\nkeep();\n",
  newText: "const a = 2;\nkeep();\n",
  oldLabel: "旧",
  newLabel: "新",
  status: "modified",
  isBinary: false,
  eolOnly: false,
  tooBig: false,
};

/** 内容相同、对象不同——父层重算时就是这个形状。 */
const sameContentCopy = (): DiffPair => ({ ...basePair });

/** createView 是异步的（先 await 语言包 import），首次 import 还要过 vitest 的
 *  模块转换——不能只 flush 两下就断言，等到编辑器真的出现再比。 */
async function waitForEditor(w: ReturnType<typeof mount>, previous?: Element) {
  await vi.waitFor(
    () => {
      const el = w.find(".cm-editor");
      expect(el.exists()).toBe(true);
      if (previous) expect(el.element).not.toBe(previous);
    },
    { timeout: 5000 },
  );
  return w.find(".cm-editor").element;
}

describe("DiffViewer 视图重建", () => {
  it("内容一字未变、只是换了个对象：不重建（编辑器节点身份不变）", async () => {
    const w = mount(DiffViewer, { props: { pair: basePair, filePath: "src/a.ts" } });
    const editor = await waitForEditor(w);

    await w.setProps({ pair: sameContentCopy() });
    await flushPromises();

    expect(w.find(".cm-editor").element).toBe(editor);
  });

  it("内容真的变了：照常重建", async () => {
    const w = mount(DiffViewer, { props: { pair: basePair, filePath: "src/a.ts" } });
    const editor = await waitForEditor(w);

    await w.setProps({ pair: { ...basePair, newText: "const a = 3;\nkeep();\n" } });
    const rebuilt = await waitForEditor(w, editor);

    expect(rebuilt).not.toBe(editor);
  });
});
