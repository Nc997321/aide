// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { hintWidgets } from "./cmInlayHints";
import type { InlayHintItem } from "../types";

// mock api（避免真 invoke；hintWidgets 纯函数不触网，mock 防模块图拉 SDK transport）
vi.mock("../api", () => ({
  api: {
    lspDidChange: vi.fn().mockResolvedValue(undefined),
    lspInlayHints: vi.fn().mockResolvedValue([]),
  },
}));

function docOf(text: string) {
  return EditorState.create({ doc: text }).doc;
}

function hint(
  kind: "type" | "param",
  line: number,
  column: number,
  label: string,
  padding: [boolean, boolean] = [false, false],
): InlayHintItem {
  return { kind, line, column, label, paddingLeft: padding[0], paddingRight: padding[1] };
}

// doc: "foo(count, 42)\nlet n = calc()\n" —— L1 长 14（from=0），L2 from=15
const DOC = "foo(count, 42)\nlet n = calc()\n";

describe("cmInlayHints hintWidgets", () => {
  it("maps param before argument and type after name (1-based column → absolute pos)", () => {
    // param：L1C5 = count 起点（1-based）→ pos 0+4=4，渲染在实参前
    // type：L2C6 = n 之后（"let n "，n 0-based 4，其后边界 1-based 6）→ pos 15+5=20
    const doc = docOf(DOC);
    const rs = hintWidgets([hint("param", 1, 5, "count: "), hint("type", 2, 6, ": i32")], doc);
    expect(rs).toHaveLength(2);
    expect(rs[0].from).toBe(4);
    expect(rs[0].to).toBe(4); // point 装饰 from === to
    expect(rs[0].value.spec.side).toBe(-1); // param：不挡光标
    expect(rs[1].from).toBe(20);
    expect(rs[1].value.spec.side).toBe(1); // type：与尾部光标共处
  });

  it("skips out-of-range lines and empty labels", () => {
    const doc = docOf(DOC);
    const rs = hintWidgets(
      [hint("param", 9, 1, "ghost: "), hint("type", 1, 1, ""), hint("param", 1, 1, "ok: ")],
      doc,
    );
    expect(rs).toHaveLength(1);
    expect(rs[0].value.spec.widget.hint.label).toBe("ok: ");
  });

  it("clamps column to line end (type hint position often points at EOL)", () => {
    const doc = docOf("let n = calc()\n");
    // L1C99 远超行尾 → clamp 到 line.to（14）；pos 是插入点，行尾渲染 = 语句后
    const rs = hintWidgets([hint("type", 1, 99, ": usize")], doc);
    expect(rs).toHaveLength(1);
    expect(rs[0].from).toBe(14);
  });

  it("sorts unsorted hints by position", () => {
    const doc = docOf(DOC);
    const rs = hintWidgets(
      [hint("type", 2, 6, ": i32"), hint("param", 1, 12, "n: "), hint("param", 1, 5, "count: ")],
      doc,
    );
    expect(rs.map((r) => r.from)).toEqual([4, 11, 20]); // L1C5→4, L1C12→11, L2C6→20
  });

  it("renders widget DOM with padding classes and label text", () => {
    const doc = docOf(DOC);
    const rs = hintWidgets(
      [hint("param", 1, 5, "count: ", [true, true]), hint("type", 2, 6, ": i32", [true, false])],
      doc,
    );
    const w1 = rs[0].value.spec.widget as import("./cmInlayHints").InlayHintWidget;
    const dom1 = w1.toDOM();
    expect(dom1.className).toBe("cm-inlayHint cm-inlayHint-padL cm-inlayHint-padR");
    expect(dom1.textContent).toBe("count: ");
    const w2 = rs[1].value.spec.widget as import("./cmInlayHints").InlayHintWidget;
    expect(w2.toDOM().className).toBe("cm-inlayHint cm-inlayHint-padL");
  });

  it("widget eq compares kind/label/padding (Decoration diff fast path)", () => {
    const doc = docOf(DOC);
    const rs = hintWidgets([hint("param", 1, 5, "count: ", [true, true])], doc);
    const w = rs[0].value.spec.widget as import("./cmInlayHints").InlayHintWidget;
    expect(w.eq(hintWidgets([hint("param", 1, 5, "count: ", [true, true])], doc)[0].value.spec.widget)).toBe(true);
    expect(w.eq(hintWidgets([hint("param", 1, 5, "count: ")], doc)[0].value.spec.widget)).toBe(false); // padding 不同
    expect(w.eq(hintWidgets([hint("type", 1, 5, "count: ", [true, true])], doc)[0].value.spec.widget)).toBe(false); // kind 不同
    expect(w.eq(hintWidgets([hint("param", 1, 5, "n: ", [true, true])], doc)[0].value.spec.widget)).toBe(false); // label 不同
  });
});
