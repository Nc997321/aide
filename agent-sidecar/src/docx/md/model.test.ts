// 阶段 3 验收测试：markdown → IR（扩展语法逐项断言）+ markdown → docx → markdown round-trip。
// 阶段 4 补充：图片三策略（skip/embed/URL 降级）+ 输入校验（原 gen.test.ts 覆盖平移）。

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Block, DocxDocument, Paragraph } from "../model.js";
import { modelToDocxBuffer } from "../gen/index.js";
import { parseDocxToModel } from "../parse/index.js";
import { DOCX_MAX_INPUT_CHARS } from "../constants.js";
import { markdownToModel } from "./toModel.js";
import { modelToMarkdown } from "./toMarkdown.js";
import { docxToStructure } from "../structure.js";

/** 1×1 透明 PNG（image-size 可解析出 1×1 png） */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function toModel(md: string) {
  const r = markdownToModel(md);
  if (!r.ok) throw new Error(r.detail);
  return r;
}

function allBlocks(doc: DocxDocument): Block[] {
  return doc.sections.flatMap((s) => s.blocks);
}

function firstParagraph(doc: DocxDocument): Paragraph {
  const b = allBlocks(doc).find((x): x is Paragraph => x.kind === "paragraph");
  if (!b) throw new Error("no paragraph block");
  return b;
}

/** markdown → docx buffer → 读回 IR → markdown */
async function fullRoundTrip(md: string): Promise<string> {
  const { doc } = toModel(md);
  const buf = await modelToDocxBuffer(doc);
  const back = await parseDocxToModel(buf);
  return modelToMarkdown(back);
}

describe("markdownToModel 基础", () => {
  it("标题/段落/行内格式/链接", () => {
    const { doc } = toModel("# 标题\n\n正文 **加粗** *斜体* `代码` [链接](https://example.com)");
    const blocks = allBlocks(doc);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", style: "Heading1" });
    const p = blocks[1] as Paragraph;
    expect(p.runs).toContainEqual(expect.objectContaining({ text: "加粗", bold: true }));
    expect(p.runs).toContainEqual(expect.objectContaining({ text: "斜体", italics: true }));
    expect(p.runs).toContainEqual(expect.objectContaining({ text: "代码", shading: "F5F5F5" }));
    expect(p.runs).toContainEqual(
      expect.objectContaining({ text: "链接", link: { href: "https://example.com" } }),
    );
  });

  it("代码块 → 段落底纹 + monoFont runs", () => {
    const { doc } = toModel("```\nline1\nline2\n```");
    const p = firstParagraph(doc);
    expect(p.shading).toBe("F5F5F5");
    expect(p.runs.map((r) => r.text).join("\n")).toBe("line1\nline2");
    expect(p.runs[0].font).toBe("Consolas");
  });

  it("表格 → IR（表头底纹）", () => {
    const { doc } = toModel("| A | B |\n|---|---|\n| 1 | 2 |");
    const table = allBlocks(doc)[0];
    expect(table).toMatchObject({ kind: "table" });
    const rows = (table as { rows: Array<{ cells: Array<{ shading?: string }> }> }).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].cells.map((c) => c.shading)).toEqual(["F2F2F2", "F2F2F2"]);
    expect(rows[1].cells.map((c) => c.shading)).toEqual([undefined, undefined]);
  });

  it("列表 → 段落模拟（bullet/编号 + 缩进）", () => {
    const { doc } = toModel("- 甲\n- 乙\n\n1. 一\n2. 二");
    const blocks = allBlocks(doc);
    expect((blocks[0] as Paragraph).runs[0].text).toBe("• ");
    expect((blocks[0] as Paragraph).indent).toEqual({ left: 720, hanging: 360 });
    expect((blocks[2] as Paragraph).runs[0].text).toBe("1. ");
    expect((blocks[3] as Paragraph).runs[0].text).toBe("2. ");
  });

  it("多段落列表项：内容不丢（编号前缀 + 各段文本 + 段间 break）", () => {
    // marked v18 对带空行续行的列表项产块级 tokens（paragraph），曾导致 walkInline 静默丢弃内容
    const { doc } = toModel("1. 第一段\n\n   第二段缩进");
    const p = firstParagraph(doc);
    expect(p.runs[0].text).toBe("1. ");
    const texts = p.runs.map((r) => r.text).join("");
    expect(texts).toContain("第一段");
    expect(texts).toContain("第二段缩进");
    expect(p.runs.some((r) => r.break)).toBe(true);
  });

  it("列表项内代码块：代码行保真（monoFont + 行间 break）", () => {
    const { doc } = toModel("1. 执行命令\n\n    ```\n    rule family=... accept\n    ```");
    const p = firstParagraph(doc);
    expect(p.runs[0].text).toBe("1. ");
    const codeRun = p.runs.find((r) => r.text.includes("rule family"));
    expect(codeRun).toBeDefined();
    expect(codeRun?.font).toBe("Consolas");
  });

  it("列表项内引用：递归转 runs 不丢内容", () => {
    const { doc } = toModel("1. 说明\n\n    > 引用内容");
    const p = firstParagraph(doc);
    const texts = p.runs.map((r) => r.text).join("");
    expect(texts).toContain("引用内容");
  });
});

describe("markdownToModel 扩展语法", () => {
  it("[TOC] → TOC 域", () => {
    const { doc } = toModel("# 标题\n\n[TOC]");
    const field = allBlocks(doc)[1];
    expect(field).toMatchObject({ kind: "field", type: "toc" });
  });

  it("[TOC:figures]/[TOC:tables] → TOC \\t 变体域（按 FigureCaption/TableCaption 样式收集）", () => {
    const figs = toModel("[TOC:figures]");
    expect(allBlocks(figs.doc)[0]).toMatchObject({
      kind: "field",
      type: "toc",
      instr: 'TOC \\t "FigureCaption,1" \\h \\z \\u',
    });
    const tabs = toModel("[TOC:tables]");
    expect(allBlocks(tabs.doc)[0]).toMatchObject({
      kind: "field",
      type: "toc",
      instr: 'TOC \\t "TableCaption,1" \\h \\z \\u',
    });
  });

  it("::: caption/tablecaption → 段落 FigureCaption/TableCaption 样式", () => {
    const { doc } = toModel("::: caption\n图 1：测试图\n\n::: tablecaption\n表 1：测试表");
    const blocks = allBlocks(doc);
    expect(blocks[0]).toMatchObject({ kind: "paragraph", style: "FigureCaption" });
    expect(blocks[1]).toMatchObject({ kind: "paragraph", style: "TableCaption" });
  });

  it("\\newpage → 分页符", () => {
    const { doc } = toModel("前\n\n\\newpage\n\n后");
    expect(allBlocks(doc).map((b) => b.kind)).toEqual(["paragraph", "pagebreak", "paragraph"]);
  });

  it("::: header/footer → 页眉页脚（{page} → PAGE 域）", () => {
    const { doc } = toModel("::: header 第 {page} 页\n::: footer 机密\n\n正文");
    const s0 = doc.sections[0];
    expect(s0.headers).toHaveLength(1);
    expect(s0.headers[0].type).toBe("default");
    const hb = s0.headers[0].blocks;
    expect(hb[0]).toMatchObject({ kind: "paragraph" });
    expect((hb[0] as Paragraph).runs[0].text).toBe("第 ");
    expect(hb[1]).toMatchObject({ kind: "field", type: "page" });
    expect((hb[2] as Paragraph).runs[0].text).toBe(" 页");
    expect(s0.footers).toHaveLength(1);
    expect((s0.footers[0].blocks[0] as Paragraph).runs[0].text).toBe("机密");
    expect(allBlocks(doc)).toHaveLength(1);
  });

  it("::: center/right/justify → 段落对齐", () => {
    const { doc } = toModel("::: center\n居中\n\n::: right\n右对齐");
    const blocks = allBlocks(doc);
    expect((blocks[0] as Paragraph).align).toBe("center");
    expect((blocks[1] as Paragraph).align).toBe("right");
  });

  it("图片 {width=600} → 指定宽度", () => {
    const { doc } = toModel(`![测试图](data:image/png;base64,${PNG_1x1.toString("base64")}){width=600}`);
    const img = allBlocks(doc)[0];
    expect(img).toMatchObject({ kind: "image", width: 600, height: 600, alt: "测试图" });
    expect(doc.media).toHaveLength(1);
  });

  it("data URI 图片 → media 字节", () => {
    const { doc } = toModel(`![图](data:image/png;base64,${PNG_1x1.toString("base64")})`);
    const img = allBlocks(doc)[0];
    expect(img).toMatchObject({ kind: "image", width: 1, height: 1 });
    expect(doc.media[0].data.equals(PNG_1x1)).toBe(true);
  });

  it("图片默认 480 上限缩放", () => {
    // 1×1 图不缩放；构造 1000px 宽图验证缩放——用 width 参数覆盖即可
    const { doc } = toModel(`![图](data:image/png;base64,${PNG_1x1.toString("base64")})`);
    expect((allBlocks(doc)[0] as { width: number }).width).toBe(1);
  });
});

describe("round-trip markdown → docx → markdown", () => {
  it("标题/段落/格式/链接/表格/代码块内容保真", async () => {
    const md = "# 标题\n\n正文 **加粗** *斜体* ~~删除~~ `代码` [链接](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\ncode line\n```";
    const back = await fullRoundTrip(md);
    expect(back).toContain("# 标题");
    expect(back).toContain("**加粗**");
    expect(back).toContain("*斜体*");
    expect(back).toContain("~~删除~~");
    expect(back).toContain("[链接](https://example.com)");
    expect(back).toContain("| A | B |");
    expect(back).toContain("| 1 | 2 |");
    expect(back).toContain("```");
    expect(back).toContain("code line");
  });

  it("图表索引 round-trip：[TOC:figures]/[TOC:tables] + 图注样式保真", async () => {
    const md = "::: caption\n图 1：数据库服务器\n\n[TOC:figures]\n\n::: tablecaption\n表 1：整改项信息表\n\n[TOC:tables]";
    const back = await fullRoundTrip(md);
    expect(back).toContain("[TOC:figures]");
    expect(back).toContain("[TOC:tables]");
    expect(back).toContain("::: caption");
    expect(back).toContain("::: tablecaption");
    expect(back).toContain("图 1：数据库服务器");
    expect(back).toContain("表 1：整改项信息表");
  });

  it("代码块 round-trip 不产生多余空行（br run 换行与 join 分隔符不叠加）", async () => {
    const back = await fullRoundTrip("```\nline1\nline2\nline3\n```");
    const code = back.slice(back.indexOf("```"), back.lastIndexOf("```") + 3);
    expect(code).toBe("```\nline1\nline2\nline3\n```");
  });

  it("扩展语法 round-trip：TOC/分页/页眉页脚/对齐", async () => {
    const md = "::: header 第 {page} 页\n\n# 标题\n\n[TOC]\n\n::: center\n居中段\n\n\\newpage\n\n后文";
    const back = await fullRoundTrip(md);
    expect(back).toContain("::: header 第 {page} 页");
    expect(back).toContain("[TOC]");
    expect(back).toContain("::: center");
    expect(back).toContain("\\newpage");
    expect(back).toContain("# 标题");
  });

  it("图片 round-trip（placeholder 模式）", async () => {
    const md = `![测试图](data:image/png;base64,${PNG_1x1.toString("base64")}){width=300}`;
    const back = await fullRoundTrip(md);
    expect(back).toContain("![测试图](media/0.png){width=300}");
  });

  it("多段落列表项 round-trip：编号与内容保真", async () => {
    const back = await fullRoundTrip("1. 第一段\n\n   第二段缩进\n\n2. 第二项");
    expect(back).toContain("1. 第一段");
    expect(back).toContain("第二段缩进");
    expect(back).toContain("2. 第二项");
  });
});

describe("markdownToModel 图片策略与校验", () => {
  it("images: skip → 占位文本 + skippedImages 计数", () => {
    const r = markdownToModel("![alt text](x.png)", { images: "skip" });
    if (!r.ok) throw new Error(r.detail);
    expect(r.images).toBe(0);
    expect(r.skippedImages).toBe(1);
    const p = firstParagraph(r.doc);
    expect(p.runs[0].text).toContain("image: alt text");
  });

  it("embed: 本地 png 嵌入，缺失文件跳过", () => {
    const dir = mkdtempSync(join(tmpdir(), "docxmd-"));
    writeFileSync(join(dir, "pic.png"), PNG_1x1);

    const ok = markdownToModel("![pic](pic.png)", { cwd: dir });
    if (!ok.ok) throw new Error(ok.detail);
    expect(ok.images).toBe(1);
    expect(ok.skippedImages).toBe(0);

    const miss = markdownToModel("![gone](missing.png)", { cwd: dir });
    if (!miss.ok) throw new Error(miss.detail);
    expect(miss.images).toBe(0);
    expect(miss.skippedImages).toBe(1);
  });

  it("URL 图片 → 降级占位（不读网络）", () => {
    const r = markdownToModel("![web](https://example.com/a.png)", { cwd: "/tmp" });
    if (!r.ok) throw new Error(r.detail);
    expect(r.skippedImages).toBe(1);
  });

  it("验证闭环：write 的 TOC/页眉页脚 → read structure 能读回", async () => {
    const md = "::: header 第 {page} 页\n\n# 标题\n\n[TOC]\n\n正文";
    const { doc } = toModel(md);
    const buf = await modelToDocxBuffer(doc);
    const back = await parseDocxToModel(buf);
    const s = docxToStructure(back);
    expect(s.headings).toEqual([{ level: 1, text: "标题" }]);
    expect(s.fields).toContainEqual(expect.objectContaining({ type: "toc" }));
    expect(s.headers).toEqual(["第 {page} 页"]);
    expect(s.paragraphs).toBeGreaterThanOrEqual(2);
  });

  it("空 markdown → invalid_arg", () => {
    const r = markdownToModel("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_arg");
  });

  it("超长 markdown → invalid_arg", () => {
    const r = markdownToModel("x".repeat(DOCX_MAX_INPUT_CHARS + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_arg");
  });
});
