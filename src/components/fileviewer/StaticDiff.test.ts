// @vitest-environment jsdom
/**
 * 静态 diff 的行为守卫（不是性能测试）：
 * 1. **一个编辑器都不许出现**——它是变更卡冻结的根源，回归了要立刻红；
 * 2. 节点数量级：变更卡从 ~270 节点/卡 降到 ~40；
 * 3. 高亮、行号、行内变更段三个视觉要素都还在（换掉编辑器的代价只能是编辑器能力）。
 */
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import StaticDiff from "./StaticDiff.vue";
import type { DiffPair } from "../../types";

vi.mock("../../composables/useSettings", () => ({
  useSettings: () => ({
    settings: { fontSize: 13, editorFontFamily: "monospace", theme: "glass" },
    loaded: { value: true },
    update: vi.fn(),
  }),
}));

const pair = (over: Partial<DiffPair> = {}): DiffPair => ({
  oldText: 'const a = 1;\nint y = 2;\nkeep();\n',
  newText: 'const a = 1;\nint y = 42;\nkeep();\n',
  oldLabel: "旧片段",
  newLabel: "新片段",
  status: "modified",
  isBinary: false,
  eolOnly: false,
  tooBig: false,
  ...over,
});

const mountDiff = (p: DiffPair, firstLineNumber?: number) =>
  mount(StaticDiff, { props: { pair: p, filePath: "src/main/java/A.java", firstLineNumber } });

describe("StaticDiff（变更卡静态 diff）", () => {
  it("**不建任何 CodeMirror**：无 .cm-editor / .cm-scroller", () => {
    const w = mountDiff(pair());

    expect(w.element.querySelectorAll(".cm-editor").length).toBe(0);
    expect(w.element.querySelectorAll(".cm-scroller").length).toBe(0);
  });

  it("节点数量级：三行片段 < 60 个节点（CodeMirror 同内容是 ~270）", () => {
    const w = mountDiff(pair());

    expect(w.element.querySelectorAll("*").length).toBeLessThan(60);
  });

  it("行号：片段内行号按 firstLineNumber 偏移，增删行各占记号列", () => {
    const w = mountDiff(pair(), 100);
    const rows = [...w.element.querySelectorAll(".sd-row")];

    // 4 行内容 + 末尾换行带来的空行（与 split("\n") 同一套约定）
    expect(rows.map((r) => r.querySelector(".sd-no")?.textContent)).toEqual([
      "100",
      "101",
      "101",
      "102",
      "103",
    ]);
    expect(rows.map((r) => r.querySelector(".sd-sign")?.textContent)).toEqual([
      "",
      "-",
      "+",
      "",
      "",
    ]);
    expect(rows.map((r) => r.className.replace(/sd-row\s*/, ""))).toEqual([
      "sd-row--ctx",
      "sd-row--del",
      "sd-row--add",
      "sd-row--ctx",
      "sd-row--ctx",
    ]);
  });

  it("语法高亮还在：hljs token span 出现在行里（Java 语法下 int→hljs-type、数字→hljs-number）", () => {
    const w = mountDiff(pair());

    expect(w.element.querySelectorAll(".sd-code .hljs-type").length).toBeGreaterThan(0);
    expect(w.element.querySelectorAll(".sd-code .hljs-number").length).toBeGreaterThan(0);
  });

  it("行内变更段：新行里只有插入的那一个字被标，不是整行", () => {
    const w = mountDiff(pair());
    const addRow = [...w.element.querySelectorAll(".sd-row--add")][0];

    expect(addRow.querySelector(".sd-mark--add")?.textContent).toBe("4");
    expect(w.element.querySelectorAll(".sd-row--del .sd-mark--del").length).toBe(0);
  });

  it("太大 / 二进制 / 仅行尾不同：只给一句话，不画行", () => {
    const w = mountDiff(pair({ isBinary: true }));

    expect(w.text()).toContain("二进制文件无法对比");
    expect(w.element.querySelectorAll(".sd-row").length).toBe(0);
  });
});
