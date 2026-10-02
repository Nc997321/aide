import { describe, it, expect } from "vitest";
import { findSection, parseOutline, sliceLines } from "./outline.js";

const DOC = [
  "# 部署手册", //            1
  "前言", //                  2
  "## 回滚", //               3
  "步骤一", //                4
  "### 数据库", //            5
  "迁移回退", //              6
  "## 监控", //               7
  "看板", //                  8
].join("\n");

describe("parseOutline", () => {
  it("ATX 标题：级别、行号、章节区间（含子节）", () => {
    const o = parseOutline(DOC);
    expect(o.map((h) => [h.level, h.title, h.line, h.endLine])).toEqual([
      [1, "部署手册", 1, 8],
      [2, "回滚", 3, 6], // 含 ### 数据库
      [3, "数据库", 5, 6],
      [2, "监控", 7, 8],
    ]);
  });

  it("围栏代码块里的 # 不算标题（文档在讲标题，不是在用）", () => {
    const o = parseOutline("# 真\n```sh\n# 注释不是标题\n```\n## 也真");
    expect(o.map((h) => h.title)).toEqual(["真", "也真"]);
  });

  it("~~~ 围栏同样跳过，且围栏种类要对上才算关闭", () => {
    const o = parseOutline("~~~\n```\n# 仍在围栏里\n~~~\n# 出来了");
    expect(o.map((h) => h.title)).toEqual(["出来了"]);
  });

  it("导入文档里的 HTML 标题也认，同一行连着多个都算", () => {
    const o = parseOutline('<h2 id="a"> 行为说明 </h2><h3 id="b"> 双写架构 </h3>\n正文');
    expect(o.map((h) => [h.level, h.title, h.line])).toEqual([
      [2, "行为说明", 1],
      [3, "双写架构", 1],
    ]);
    // 同一行里连着的标题：第一节至少含它自己那一行，不出现 end < start
    expect(o.every((h) => h.endLine >= h.line)).toBe(true);
  });

  it("标题文字里的行内标记被剥掉；闭合 # 去掉", () => {
    const o = parseOutline("## **粗** `代码` [链接](http://e.com) ##");
    expect(o[0].title).toBe("粗 代码 链接");
  });

  it("没有标题 → 空大纲；# 后无空格（#tag）不算标题", () => {
    expect(parseOutline("只有正文\n#标签")).toEqual([]);
  });

  it("末尾章节延伸到文末", () => {
    expect(parseOutline("# a\n\n\nx")[0].endLine).toBe(4);
  });
});

describe("findSection", () => {
  const o = parseOutline(DOC);

  it("整串相等（忽略大小写与首尾空白）优先", () => {
    const r = findSection(parseOutline("# API\n## api 网关\n"), " api ");
    expect(r.kind).toBe("found");
  });

  it("唯一包含也命中", () => {
    const r = findSection(o, "监");
    expect(r.kind === "found" && r.heading.title).toBe("监控");
  });

  it("多处命中交回候选，不替模型猜", () => {
    const r = findSection(parseOutline("## 回滚 A\n## 回滚 B"), "回滚");
    expect(r.kind === "ambiguous" && r.candidates.length).toBe(2);
  });

  it("没有命中 / 空查询 → none", () => {
    expect(findSection(o, "不存在").kind).toBe("none");
    expect(findSection(o, "  ").kind).toBe("none");
  });
});

describe("sliceLines", () => {
  it("闭区间、1 起算", () => {
    expect(sliceLines(DOC, 3, 4)).toMatchObject({ text: "## 回滚\n步骤一", start: 3, end: 4, total: 8 });
  });
  it("越界收紧到文档边界；反向区间为空", () => {
    expect(sliceLines(DOC, 7, 999).end).toBe(8);
    expect(sliceLines(DOC, 5, 2).text).toBe("");
  });
});
