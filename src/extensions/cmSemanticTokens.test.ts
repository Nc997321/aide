import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { tokenRanges } from "./cmSemanticTokens";
import type { SemanticToken } from "../types";

// mock api（避免真 invoke；tokenRanges 纯函数不触网，mock 防模块图拉 SDK transport）
vi.mock("../api", () => ({
  api: {
    lspDidChange: vi.fn().mockResolvedValue(undefined),
    lspSemanticTokens: vi.fn().mockResolvedValue([]),
  },
}));

function docOf(text: string) {
  return EditorState.create({ doc: text }).doc;
}

function tok(line: number, startChar: number, length: number, tokenType: string, tokenModifiers: string[] = []): SemanticToken {
  return { line, startChar, length, tokenType, tokenModifiers };
}

describe("cmSemanticTokens tokenRanges", () => {
  it("maps colorable types to class and computes absolute positions", () => {
    // doc: "foo bar\nbaz qux\n" —— L1C0 len3 method；L2C4 len3 variable
    const doc = docOf("foo bar\nbaz qux\n");
    const rs = tokenRanges([tok(1, 0, 3, "method"), tok(2, 4, 3, "variable")], doc);
    expect(rs).toHaveLength(2);
    expect(rs[0].from).toBe(0);
    expect(rs[0].to).toBe(3);
    expect(rs[0].value.spec.class).toBe("aide-st-fn");
    expect(rs[1].from).toBe(8 + 4);
    expect(rs[1].value.spec.class).toBe("aide-st-var");
  });

  it("skips syntax-highlight-covered types (keyword/string/comment...)", () => {
    const doc = docOf("if (x) { return \"s\"; }");
    const rs = tokenRanges(
      [tok(1, 0, 2, "keyword"), tok(1, 3, 1, "variable"), tok(1, 12, 3, "string"), tok(1, 5, 1, "parameter")],
      doc,
    );
    // keyword/string 跳过；variable/parameter 保留（同 variable 色板）
    expect(rs).toHaveLength(2);
    expect(rs.map((r) => r.value.spec.class)).toEqual(["aide-st-var", "aide-st-var"]);
  });

  it("clamps token end to line end and skips out-of-range lines/positions", () => {
    const doc = docOf("ab\ncd\n");
    // L1 越界（length 超行尾）→ clamp 到行尾；L9 不存在 → 跳过；
    // L2 startChar 超行尾 → 跳过
    const rs = tokenRanges([tok(1, 0, 99, "method"), tok(9, 0, 2, "method"), tok(2, 99, 1, "method")], doc);
    expect(rs).toHaveLength(1);
    expect(rs[0].from).toBe(0);
    expect(rs[0].to).toBe(2); // clamp 到行尾
  });

  it("appends deprecated modifier class for strikethrough", () => {
    const doc = docOf("oldApi");
    const rs = tokenRanges([tok(1, 0, 6, "method", ["deprecated", "static"])], doc);
    expect(rs).toHaveLength(1);
    expect(rs[0].value.spec.class).toBe("aide-st-fn aide-stm-deprecated");
  });

  it("sorts unsorted tokens and drops overlapping ranges", () => {
    const doc = docOf("aaaa bbbb");
    // 乱序输入（L1C5 在 L1C0 之后但先给）+ 与前一个区间交叠的 token（C1 len9
    // 覆盖 C5）→ RangeSet 不容部分交叠，交叠者丢弃不炸
    const rs = tokenRanges([tok(1, 5, 4, "variable"), tok(1, 0, 4, "method"), tok(1, 1, 9, "class")], doc);
    expect(rs).toHaveLength(2);
    expect(rs[0].from).toBe(0);
    expect(rs[0].to).toBe(4);
    expect(rs[1].from).toBe(5);
    expect(rs[1].to).toBe(9);
  });
});
