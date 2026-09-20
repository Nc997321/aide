import { describe, it, expect } from "vitest";
import { buildDiffRows, type DiffRow } from "./diffRows";

/** 压成好读的形状：`ctx 1|1 a`、`del 2 - b [8,9]`、`add - 2 B`。 */
function shape(rows: DiffRow[]): string[] {
  return rows.map((r) => {
    const marks = r.marks.length ? ` [${r.marks.map(([s, e]) => `${s},${e}`).join(" ")}]` : "";
    return `${r.kind} ${r.aLine ?? "-"}|${r.bLine ?? "-"} ${JSON.stringify(r.text)}${marks}`;
  });
}

describe("buildDiffRows（片段 diff → 行模型）", () => {
  it("完全相同：全部 ctx，行号两侧同步", () => {
    const rows = buildDiffRows("a\nb", "a\nb");

    expect(shape(rows)).toEqual(['ctx 1|1 "a"', 'ctx 2|2 "b"']);
    expect(rows.every((r) => r.marks.length === 0)).toBe(true);
  });

  it("行内换词：删/增各一行，两侧各带一段行内变更段（不是整行）", () => {
    const rows = buildDiffRows("a.eq(x);", "a.like(x);");

    expect(shape(rows)).toEqual([
      'del 1|- "a.eq(x);" [2,4]', // eq
      'add -|1 "a.like(x);" [2,6]', // like
    ]);
  });

  it("行内插入字符：旧行整行未删（无行内段），新行只标插入的那一个字", () => {
    // "2" → "42" 在差异算法里是「插入 4」，旧侧没有对应区间可标——
    // 给旧行造一段零宽标记只会画出假的高亮
    const rows = buildDiffRows("int x = 1;\nint y = 2;", "int x = 1;\nint y = 42;");

    expect(shape(rows)).toEqual([
      'ctx 1|1 "int x = 1;"',
      'del 2|- "int y = 2;"',
      'add -|2 "int y = 42;" [8,9]', // 插入的 "4"
    ]);
  });

  it("整行替换：只给行底色，不再叠行内变更段", () => {
    // 整行都变了，"行内变更段"没有信息量；CodeMirror 的 unified 视图同样只涂行底
    const rows = buildDiffRows("a\nb\nc", "a\nB\nc");

    expect(shape(rows)).toEqual(['ctx 1|1 "a"', 'del 2|- "b"', 'add -|2 "B"', 'ctx 3|3 "c"']);
  });

  it("纯插入一行：只有 add，行号在两侧各自连续", () => {
    const rows = buildDiffRows("a\nc", "a\nb\nc");

    expect(shape(rows)).toEqual(['ctx 1|1 "a"', 'add -|2 "b"', 'ctx 2|3 "c"']);
  });

  it("纯删除一行：只有 del", () => {
    const rows = buildDiffRows("a\nb\nc", "a\nc");

    expect(shape(rows)).toEqual(['ctx 1|1 "a"', 'del 2|- "b"', 'ctx 3|2 "c"']);
  });

  it("多行块替换：del 段整体在前、add 段在后（unified 顺序）", () => {
    const rows = buildDiffRows("keep\nold1\nold2\ntail", "keep\nnew1\ntail");

    expect(shape(rows)).toEqual([
      'ctx 1|1 "keep"',
      'del 2|- "old1"',
      'del 3|- "old2"',
      'add -|2 "new1"',
      'ctx 4|3 "tail"',
    ]);
  });

  it("新增文件（old 为空）：整段都是 add", () => {
    const rows = buildDiffRows("", "line1\nline2");

    expect(shape(rows)).toEqual(['add -|1 "line1"', 'add -|2 "line2"']);
  });

  it("末尾空行参与行号（与 highlightLines 的 split('\\n') 约定一致）", () => {
    const rows = buildDiffRows("a\n", "a\n");

    expect(shape(rows)).toEqual(['ctx 1|1 "a"', 'ctx 2|2 ""']);
  });
});
