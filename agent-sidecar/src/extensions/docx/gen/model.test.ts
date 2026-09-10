// 阶段 2 验收测试：IR → modelToDocxBuffer → parseDocxToModel 回读 round-trip 断言。
// 覆盖段落格式/表格/图片/域/分页符/书签/超链接/页眉页脚/多节/样式。

import { describe, it, expect } from "vitest";
import type { Block, DocxDocument, Paragraph } from "../model.js";
import { parseDocxToModel } from "../parse/index.js";
import { modelToDocxBuffer } from "./index.js";

/** 1×1 透明 PNG（image-size 可解析出 1×1 png） */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function makeDoc(blocks: Block[], extra?: Partial<DocxDocument>): DocxDocument {
  return {
    sections: [{ headers: [], footers: [], blocks }],
    styles: new Map(),
    media: [],
    ...extra,
  };
}

/** IR → buffer → 回读 IR */
async function roundTrip(doc: DocxDocument): Promise<DocxDocument> {
  const buf = await modelToDocxBuffer(doc);
  return parseDocxToModel(buf);
}

function allBlocks(doc: DocxDocument): Block[] {
  return doc.sections.flatMap((s) => s.blocks);
}

function firstParagraph(doc: DocxDocument): Paragraph {
  const b = allBlocks(doc).find((x): x is Paragraph => x.kind === "paragraph");
  if (!b) throw new Error("no paragraph block");
  return b;
}

describe("modelToDocxBuffer 段落", () => {
  it("run 格式与段落属性 round-trip", async () => {
    const back = await roundTrip(
      makeDoc([
        {
          kind: "paragraph",
          runs: [
            { text: "Bold", bold: true, italics: true, underline: true, strike: true, color: "#FF0000", size: 28 },
            { text: " plain" },
          ],
          align: "center",
          indent: { left: 720, hanging: 240 },
          spacing: { before: 120, after: 120 },
        },
      ]),
    );
    const p = firstParagraph(back);
    expect(p.align).toBe("center");
    expect(p.indent).toEqual({ left: 720, hanging: 240 });
    expect(p.spacing).toEqual({ before: 120, after: 120 });
    expect(p.runs).toHaveLength(2);
    expect(p.runs[0]).toMatchObject({
      text: "Bold",
      bold: true,
      italics: true,
      underline: true,
      strike: true,
      color: "#FF0000",
      size: 28,
    });
    expect(p.runs[1].text).toBe(" plain");
  });

  it("\\t 拆 Tab、\\n 拆段内换行", async () => {
    const back = await roundTrip(
      makeDoc([{ kind: "paragraph", runs: [{ text: "a\tb\nc" }] }]),
    );
    const p = firstParagraph(back);
    expect(p.runs.map((r) => r.text).join("")).toBe("a\tb\nc");
  });

  it("IR break 标志 → <w:br/>（代码块多行换行保留）", async () => {
    const back = await roundTrip(
      makeDoc([
        {
          kind: "paragraph",
          runs: [
            { text: "line1" },
            { text: "line2", break: true },
            { text: "line3", break: true },
          ],
          shading: "F5F5F5",
        },
      ]),
    );
    const p = firstParagraph(back);
    // 每行独立 run + break 标志 → 行首 <w:br/> → 读回 text 含 \n
    expect(p.runs.map((r) => r.text).join("")).toBe("line1\nline2\nline3");
  });

  it("Heading1 样式 → heading 属性（docx 库自带样式）", async () => {
    const back = await roundTrip(
      makeDoc([{ kind: "paragraph", style: "Heading1", runs: [{ text: "标题" }] }]),
    );
    const p = firstParagraph(back);
    expect(p.style).toBe("Heading1");
  });
});

describe("modelToDocxBuffer 表格", () => {
  it("列宽/gridSpan/底纹/单元格内容 round-trip", async () => {
    const back = await roundTrip(
      makeDoc([
        {
          kind: "table",
          widths: [3000, 2000],
          rows: [
            {
              cells: [
                {
                  blocks: [{ kind: "paragraph", runs: [{ text: "A1" }] }],
                  width: 3000,
                  shading: "D9E2F3",
                },
                { blocks: [{ kind: "paragraph", runs: [{ text: "B1" }] }], gridSpan: 2 },
              ],
            },
          ],
        },
      ]),
    );
    const table = allBlocks(back)[0];
    expect(table).toMatchObject({
      kind: "table",
      widths: [3000, 2000],
      rows: [{ cells: [{ width: 3000, shading: "D9E2F3" }, { gridSpan: 2 }] }],
    });
    const rows = (table as { rows: Array<{ cells: Array<{ blocks: Block[] }> }> }).rows;
    expect((rows[0].cells[0].blocks[0] as Paragraph).runs[0].text).toBe("A1");
    expect((rows[0].cells[1].blocks[0] as Paragraph).runs[0].text).toBe("B1");
  });
});

describe("modelToDocxBuffer 图片", () => {
  it("media 字节/尺寸/alt round-trip", async () => {
    const back = await roundTrip(
      makeDoc(
        [{ kind: "image", mediaId: 0, width: 100, height: 200, alt: "测试图" }],
        { media: [{ data: PNG_1x1, type: "png", width: 1, height: 1 }] },
      ),
    );
    expect(back.media).toHaveLength(1);
    expect(back.media[0].data.equals(PNG_1x1)).toBe(true);
    expect(back.media[0]).toMatchObject({ type: "png", width: 1, height: 1 });
    expect(allBlocks(back)[0]).toEqual({
      kind: "image",
      mediaId: 0,
      width: 100,
      height: 200,
      alt: "测试图",
    });
  });

  it("media 缺失 → 降级占位文本", async () => {
    const back = await roundTrip(makeDoc([{ kind: "image", mediaId: 99, width: 100, height: 100 }]));
    const p = firstParagraph(back);
    expect(p.runs[0].text).toContain("[image:");
  });
});

describe("modelToDocxBuffer 域", () => {
  it("TOC 域 round-trip（TableOfContents → sdt 包裹 → 读回 toc + 缓存条目）", async () => {
    const back = await roundTrip(
      makeDoc([
        {
          kind: "field",
          type: "toc",
          instr: 'TOC \\o "1-3" \\h \\z \\u',
          cached: [
            { kind: "paragraph", style: "TOC1", runs: [{ text: "第一章" }] },
            { kind: "paragraph", style: "TOC2", runs: [{ text: "第一节" }] },
          ],
        },
      ]),
    );
    const field = allBlocks(back)[0];
    expect(field).toMatchObject({ kind: "field", type: "toc" });
    const cached = (field as { cached?: Array<{ style?: string; runs: Array<{ text: string }> }> }).cached;
    expect(cached).toHaveLength(2);
    expect(cached![0].style).toBe("TOC1");
    // docx 库缓存条目 run 是 t + tab + t 合并（标题 + 制表位 + 页码占位）
    expect(cached![0].runs[0].text).toBe("第一章\t");
    expect(cached![1].style).toBe("TOC2");
    expect(cached![1].runs[0].text).toBe("第一节\t");
  });

  it("PAGE 域 round-trip（SimpleField → 读回 page + 缓存文本）", async () => {
    const back = await roundTrip(
      makeDoc([
        { kind: "field", type: "page", instr: "PAGE", cached: [{ kind: "paragraph", runs: [{ text: "1" }] }] },
      ]),
    );
    const field = allBlocks(back)[0];
    expect(field).toMatchObject({ kind: "field", type: "page" });
    const cached = (field as { cached?: Array<{ runs: Array<{ text: string }> }> }).cached;
    expect(cached![0].runs[0].text).toBe("1");
  });

  it("TOC 域自动补 TOC1/TOC2 兜底样式", async () => {
    const back = await roundTrip(
      makeDoc([{ kind: "field", type: "toc", cached: [{ kind: "paragraph", style: "TOC1", runs: [{ text: "x" }] }] }]),
    );
    expect(back.styles.has("TOC1")).toBe(true);
    expect(back.styles.has("TOC2")).toBe(true);
  });
});

describe("modelToDocxBuffer 其它块", () => {
  it("分页符 round-trip", async () => {
    const back = await roundTrip(
      makeDoc([
        { kind: "paragraph", runs: [{ text: "前" }] },
        { kind: "pagebreak" },
        { kind: "paragraph", runs: [{ text: "后" }] },
      ]),
    );
    expect(allBlocks(back).map((b) => b.kind)).toEqual(["paragraph", "pagebreak", "paragraph"]);
  });

  it("书签 + 内部超链接 round-trip", async () => {
    const back = await roundTrip(
      makeDoc([
        { kind: "bookmark", name: "_Toc123", anchor: true },
        { kind: "paragraph", runs: [{ text: "跳转", link: { anchor: "_Toc123" } }] },
      ]),
    );
    const blocks = allBlocks(back);
    expect(blocks[0]).toEqual({ kind: "bookmark", name: "_Toc123", anchor: true });
    const p = blocks[1] as Paragraph;
    expect(p.runs[0].link).toEqual({ anchor: "_Toc123" });
  });

  it("外部超链接 round-trip", async () => {
    const back = await roundTrip(
      makeDoc([{ kind: "paragraph", runs: [{ text: "链接", link: { href: "https://example.com" } }] }]),
    );
    const p = firstParagraph(back);
    expect(p.runs[0].link).toEqual({ href: "https://example.com" });
  });

  it("hr round-trip（下边框段落）", async () => {
    const back = await roundTrip(makeDoc([{ kind: "hr" }]));
    expect(allBlocks(back)[0].kind).toBe("paragraph");
  });
});

describe("modelToDocxBuffer 分节与页眉页脚", () => {
  it("多节属性 round-trip（页面尺寸/边距/页码格式/起始页/首页不同）", async () => {
    const back = await roundTrip({
      sections: [
        {
          headers: [],
          footers: [],
          pageSize: { width: 11906, height: 16838 },
          pageMargins: { top: 1440, right: 1800, bottom: 1440, left: 1800 },
          pageNumberFormat: "upperRoman",
          startPageNumber: 1,
          titlePg: true,
          blocks: [{ kind: "paragraph", runs: [{ text: "第一节" }] }],
        },
        {
          headers: [],
          footers: [],
          pageSize: { width: 12240, height: 15840 },
          blocks: [{ kind: "paragraph", runs: [{ text: "第二节" }] }],
        },
      ],
      styles: new Map(),
      media: [],
    });
    expect(back.sections).toHaveLength(2);
    const s0 = back.sections[0];
    expect(s0.pageSize).toEqual({ width: 11906, height: 16838 });
    expect(s0.pageMargins).toEqual({ top: 1440, right: 1800, bottom: 1440, left: 1800 });
    expect(s0.pageNumberFormat).toBe("upperRoman");
    expect(s0.startPageNumber).toBe(1);
    expect(s0.titlePg).toBe(true);
    expect((s0.blocks[0] as Paragraph).runs[0].text).toBe("第一节");
    const s1 = back.sections[1];
    expect(s1.pageSize).toEqual({ width: 12240, height: 15840 });
    expect((s1.blocks[0] as Paragraph).runs[0].text).toBe("第二节");
  });

  it("页眉页脚 round-trip（含 PAGE 域）", async () => {
    const back = await roundTrip({
      sections: [
        {
          headers: [
            { type: "default", blocks: [{ kind: "paragraph", runs: [{ text: "页眉文本" }] }] },
          ],
          footers: [
            {
              type: "default",
              blocks: [
                { kind: "paragraph", runs: [{ text: "第 " }] },
                { kind: "field", type: "page", instr: "PAGE", cached: [{ kind: "paragraph", runs: [{ text: "1" }] }] },
                { kind: "paragraph", runs: [{ text: " 页" }] },
              ],
            },
          ],
          blocks: [{ kind: "paragraph", runs: [{ text: "正文" }] }],
        },
      ],
      styles: new Map(),
      media: [],
    });
    const s0 = back.sections[0];
    expect(s0.headers).toHaveLength(1);
    expect((s0.headers[0].blocks[0] as Paragraph).runs[0].text).toBe("页眉文本");
    expect(s0.footers).toHaveLength(1);
    const ftr = s0.footers[0];
    expect(ftr.blocks).toHaveLength(3);
    expect((ftr.blocks[0] as Paragraph).runs[0].text).toBe("第 ");
    expect(ftr.blocks[1]).toMatchObject({ kind: "field", type: "page" });
    expect((ftr.blocks[2] as Paragraph).runs[0].text).toBe(" 页");
  });
});

describe("modelToDocxBuffer 样式", () => {
  it("自定义样式 round-trip（basedOn 继承合并）", async () => {
    const back = await roundTrip(
      makeDoc(
        [{ kind: "paragraph", style: "MyStyle", runs: [{ text: "x" }] }],
        {
          styles: new Map([
            [
              "MyStyle",
              {
                id: "MyStyle",
                name: "my style",
                type: "paragraph",
                basedOn: "Normal",
                bold: true,
                size: 24,
                align: "center",
              },
            ],
          ]),
        },
      ),
    );
    const s = back.styles.get("MyStyle");
    expect(s).toMatchObject({
      id: "MyStyle",
      name: "my style",
      basedOn: "Normal",
      bold: true,
      size: 24,
      align: "center",
    });
    const p = firstParagraph(back);
    expect(p.style).toBe("MyStyle");
  });
});
