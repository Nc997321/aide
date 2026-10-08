// @vitest-environment jsdom
// 相对导入而非 `@/`：测试文件被 tsconfig exclude，解析不了别名（与同目录其它测试一致）。
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { FORMAT_ACTIONS } from "./mdCommands";

function make(doc: string, from: number, to = from): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection: EditorSelection.range(from, to), extensions: [EditorState.allowMultipleSelections.of(true)] }),
  });
}
const text = (v: EditorView) => v.state.doc.toString();
const sel = (v: EditorView) => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);

describe("行内标记", () => {
  it("选中文字 → 加粗，选区保持在文字上", () => {
    const v = make("hello world", 6, 11);
    FORMAT_ACTIONS.bold(v);
    expect(text(v)).toBe("hello **world**");
    expect(sel(v)).toBe("world");
  });

  it("再点一次 → 拆掉（外围包住 / 选区自带标记两种）", () => {
    const v = make("a **b** c", 4, 5);
    FORMAT_ACTIONS.bold(v);
    expect(text(v)).toBe("a b c");

    const w = make("a **b** c", 2, 7);
    FORMAT_ACTIONS.bold(w);
    expect(text(w)).toBe("a b c");
  });

  it("空选区 → 插入一对标记并选中占位文字", () => {
    const v = make("", 0);
    FORMAT_ACTIONS.code(v);
    expect(text(v)).toBe("`代码`");
    expect(sel(v)).toBe("代码");
  });

  it("粗体里的文字点斜体：不把粗体的一半当斜体拆掉", () => {
    const v = make("**x**", 2, 3);
    FORMAT_ACTIONS.italic(v);
    expect(text(v)).toBe("***x***");
  });
});

describe("行首前缀", () => {
  it("标题：加上 / 同级再点去掉 / 换级是替换不是叠加", () => {
    const v = make("标题", 0);
    FORMAT_ACTIONS.h2(v);
    expect(text(v)).toBe("## 标题");
    FORMAT_ACTIONS.h3(v);
    expect(text(v)).toBe("### 标题");
    FORMAT_ACTIONS.h3(v);
    expect(text(v)).toBe("标题");
  });

  it("多行选区：每行都加；全都有时全部去掉", () => {
    const v = make("a\nb\nc", 0, 5);
    FORMAT_ACTIONS.ul(v);
    expect(text(v)).toBe("- a\n- b\n- c");
    FORMAT_ACTIONS.ul(v);
    expect(text(v)).toBe("a\nb\nc");
  });

  it("有序列表：递增编号", () => {
    const v = make("a\nb", 0, 3);
    FORMAT_ACTIONS.ol(v);
    expect(text(v)).toBe("1. a\n2. b");
  });

  it("整行选中（止于下一行行首）不波及下一行", () => {
    const v = make("a\nb", 0, 2);
    FORMAT_ACTIONS.quote(v);
    expect(text(v)).toBe("> a\nb");
  });

  it("无序 → 有序是替换旧前缀", () => {
    const v = make("- a", 0);
    FORMAT_ACTIONS.ol(v);
    expect(text(v)).toBe("1. a");
  });
});

describe("链接与代码块", () => {
  it("链接：选区变链接文字，url 占位被选中", () => {
    const v = make("看文档", 0, 3);
    FORMAT_ACTIONS.link(v);
    expect(text(v)).toBe("[看文档](https://)");
    expect(sel(v)).toBe("https://");
  });

  it("代码块：包住选区并各占一行；空选区放进空围栏", () => {
    const v = make("x = 1", 0, 5);
    FORMAT_ACTIONS.codeBlock(v);
    expect(text(v)).toBe("```\nx = 1\n```\n");

    const w = make("", 0);
    FORMAT_ACTIONS.codeBlock(w);
    expect(text(w)).toBe("```\n\n```\n");
    expect(w.state.selection.main.from).toBe(4);
  });
});
