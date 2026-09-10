// 阶段 1 验收测试：jszip 内存构造完整 OOXML（段落/表格/图片/域/分节/页眉页脚/样式）
// → parseDocxToModel → IR 断言。沿用 parse.test.ts 的 makeDocx 范式，扩展部件与媒体。

import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import type { Block, DocxDocument, Paragraph } from "../model.js";
import { DocxParseError, parseDocxToModel } from "./index.js";

/** 1×1 透明 PNG（image-size 可解析出 1×1 png） */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface DocxSpec {
  bodyXml: string;
  stylesXml?: string;
  /** document.xml.rels 的额外 Relationship（rId1=officeDocument 恒有） */
  extraRels?: string;
  /** 额外部件（header/footer 等）：path 为 zip 内路径 */
  parts?: Array<{ path: string; xml: string }>;
  /** media 文件（zip 内路径 → 字节） */
  media?: Array<{ path: string; data: Buffer }>;
}

function contentTypeFor(path: string): string {
  const base = "application/vnd.openxmlformats-officedocument.wordprocessingml.";
  if (path.includes("header")) return `${base}header+xml`;
  if (path.includes("footer")) return `${base}footer+xml`;
  if (path.includes("styles")) return `${base}styles+xml`;
  return `${base}document.main+xml`;
}

/** 内存构造 .docx：document.xml + rels + styles + 部件 + media */
async function makeDocx(spec: DocxSpec): Promise<Buffer> {
  const zip = new JSZip();
  const xmlDecl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const relsNs = "http://schemas.openxmlformats.org/package/2006/relationships";

  const overrides = ["/word/document.xml"];
  for (const part of spec.parts ?? []) overrides.push(`/${part.path}`);
  if (spec.stylesXml) overrides.push("/word/styles.xml");

  zip.file(
    "[Content_Types].xml",
    `${xmlDecl}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
${overrides.map((p) => `  <Override PartName="${p}" ContentType="${contentTypeFor(p)}"/>`).join("\n")}
</Types>`,
  );

  const extraRels = spec.extraRels ?? "";
  zip.folder("_rels")!.file(
    ".rels",
    `${xmlDecl}
<Relationships xmlns="${relsNs}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word")!.file(
    "document.xml",
    `${xmlDecl}
<w:document xmlns:w="${w}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${spec.bodyXml}</w:body>
</w:document>`,
  );
  zip.folder("word")!.folder("_rels")!.file(
    "document.xml.rels",
    `${xmlDecl}
<Relationships xmlns="${relsNs}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="document.xml"/>
${extraRels}
</Relationships>`,
  );
  if (spec.stylesXml) {
    zip.folder("word")!.file("styles.xml", `${xmlDecl}\n${spec.stylesXml}`);
  }
  for (const part of spec.parts ?? []) {
    zip.folder("word")!.file(part.path.replace(/^word\//, ""), `${xmlDecl}\n${part.xml}`);
  }
  for (const m of spec.media ?? []) {
    zip.file(m.path, m.data);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 全部正文块（跨节拼接） */
function allBlocks(doc: DocxDocument): Block[] {
  return doc.sections.flatMap((s) => s.blocks);
}

function firstParagraph(doc: DocxDocument): Paragraph {
  const b = allBlocks(doc).find((x): x is Paragraph => x.kind === "paragraph");
  if (!b) throw new Error("no paragraph block");
  return b;
}

describe("parseDocxToModel 段落", () => {
  it("解析 run 格式（加粗/斜体/下划线/颜色/字号）与段落属性（对齐/缩进/间距）", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p>
  <w:pPr><w:jc w:val="center"/><w:ind w:left="720" w:hanging="240"/><w:spacing w:before="120" w:after="120"/></w:pPr>
  <w:r><w:rPr><w:b/><w:i/><w:u/><w:color w:val="FF0000"/><w:sz w:val="28"/></w:rPr><w:t>Bold</w:t></w:r>
  <w:r><w:t> plain</w:t></w:r>
</w:p>`,
    });
    const doc = await parseDocxToModel(buf);
    const p = firstParagraph(doc);
    expect(p.align).toBe("center");
    expect(p.indent).toEqual({ left: 720, hanging: 240 });
    expect(p.spacing).toEqual({ before: 120, after: 120 });
    expect(p.runs).toHaveLength(2);
    expect(p.runs[0]).toMatchObject({
      text: "Bold",
      bold: true,
      italics: true,
      underline: true,
      color: "#FF0000",
      size: 28,
    });
    expect(p.runs[1].text).toBe(" plain");
  });

  it("w:b w:val=0 视为不加粗；空段保底输出", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>a</w:t></w:r></w:p><w:p/>`,
    });
    const doc = await parseDocxToModel(buf);
    const blocks = allBlocks(doc);
    expect(blocks).toHaveLength(2);
    expect(firstParagraph(doc).runs[0].bold).toBeUndefined();
  });

  it("段内 br/tab 与实体解码", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:r><w:t>a&amp;b</w:t><w:br/><w:t>c</w:t><w:tab/><w:t>d</w:t></w:r></w:p>`,
    });
    const doc = await parseDocxToModel(buf);
    expect(firstParagraph(doc).runs[0].text).toBe("a&b\nc\td");
    expect(firstParagraph(doc).runs[0].break).toBe(true);
  });

  it("书签与超链接（外部 href）", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p>
  <w:bookmarkStart w:id="0" w:name="_Toc123"/><w:bookmarkEnd w:id="0"/>
  <w:hyperlink r:id="rIdLink"><w:r><w:t>链接</w:t></w:r></w:hyperlink>
</w:p>`,
      extraRels: `<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com"/>`,
    });
    const doc = await parseDocxToModel(buf);
    const blocks = allBlocks(doc);
    expect(blocks[0]).toEqual({ kind: "bookmark", name: "_Toc123", anchor: true });
    const p = blocks[1] as Paragraph;
    expect(p.runs[0].link).toEqual({ href: "https://example.com" });
  });
});

describe("parseDocxToModel 表格", () => {
  it("解析列宽/gridSpan 合并/单元格底纹/嵌套块", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:tbl>
  <w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
  <w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="2000"/></w:tblGrid>
  <w:tr>
    <w:tc>
      <w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:fill="D9E2F3"/></w:tcPr>
      <w:p><w:r><w:t>A1</w:t></w:r></w:p>
    </w:tc>
    <w:tc>
      <w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
      <w:p><w:r><w:t>B1</w:t></w:r></w:p>
    </w:tc>
  </w:tr>
</w:tbl>`,
    });
    const doc = await parseDocxToModel(buf);
    const table = allBlocks(doc)[0];
    expect(table).toMatchObject({
      kind: "table",
      widths: [3000, 2000],
      rows: [{ cells: [{ width: 3000, shading: "D9E2F3" }, { gridSpan: 2 }] }],
    });
    const rows = (table as { rows: Array<{ cells: Array<{ blocks: Block[] }> }> }).rows;
    expect(rows[0].cells[0].blocks).toHaveLength(1);
    expect((rows[0].cells[0].blocks[0] as Paragraph).runs[0].text).toBe("A1");
  });
});

describe("parseDocxToModel 图片", () => {
  it("drawing → Image 块（EMU→px 尺寸、alt、media 字节）", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:r>
  <w:drawing>
    <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
      <wp:extent cx="952500" cy="1905000"/>
      <wp:docPr id="1" name="Picture 1" descr="测试图"/>
      <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill>
            <pic:spPr><a:xfrm><a:ext cx="952500" cy="1905000"/></a:xfrm></pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing>
</w:r></w:p>`,
      extraRels: `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>`,
      media: [{ path: "word/media/image1.png", data: PNG_1x1 }],
    });
    const doc = await parseDocxToModel(buf);
    expect(doc.media).toHaveLength(1);
    expect(doc.media[0]).toMatchObject({ type: "png", width: 1, height: 1 });
    const img = allBlocks(doc)[0];
    expect(img).toEqual({
      kind: "image",
      mediaId: 0,
      width: 100, // 952500 EMU / 9525 = 100px
      height: 200,
      alt: "测试图",
    });
  });

  it("文本与图片交错 → 按顺序拆多个块", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:r><w:t>前文</w:t></w:r><w:r>
  <w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
    <wp:extent cx="95250" cy="95250"/>
    <wp:docPr id="1" name="P" descr=""/>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline></w:drawing>
</w:r><w:r><w:t>后文</w:t></w:r></w:p>`,
      extraRels: `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>`,
      media: [{ path: "word/media/image1.png", data: PNG_1x1 }],
    });
    const doc = await parseDocxToModel(buf);
    const kinds = allBlocks(doc).map((b) => b.kind);
    expect(kinds).toEqual(["paragraph", "image", "paragraph"]);
    const paras = allBlocks(doc).filter((b): b is Paragraph => b.kind === "paragraph");
    expect(paras[0].runs[0].text).toBe("前文");
    expect(paras[1].runs[0].text).toBe("后文");
  });
});

describe("parseDocxToModel 域", () => {
  it("TOC 域：指令 + 缓存条目", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>
  <w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>
  <w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="separate"/></w:r>
  <w:r><w:t>第一章</w:t></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r>
</w:p>`,
    });
    const doc = await parseDocxToModel(buf);
    const field = allBlocks(doc)[0];
    expect(field).toMatchObject({
      kind: "field",
      type: "toc",
      instr: 'TOC \\o "1-3" \\h \\z \\u',
    });
    const cached = (field as { cached?: Array<{ runs: Array<{ text: string }> }> }).cached;
    expect(cached).toHaveLength(1);
    expect(cached![0].runs[0].text).toBe("第一章");
  });

  it("PAGE 域 / NUMPAGES 域分类；未知域 → other", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>
  <w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>
  <w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>9</w:t></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>
  <w:r><w:instrText xml:space="preserve"> REF _Toc123 </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`,
    });
    const doc = await parseDocxToModel(buf);
    const types = allBlocks(doc).map((b) => (b.kind === "field" ? b.type : "?"));
    expect(types).toEqual(["page", "numpages", "other"]);
  });

  it("独立分页段 → pagebreak 块", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:r><w:t>前</w:t></w:r></w:p>
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
<w:p><w:r><w:t>后</w:t></w:r></w:p>`,
    });
    const doc = await parseDocxToModel(buf);
    expect(allBlocks(doc).map((b) => b.kind)).toEqual(["paragraph", "pagebreak", "paragraph"]);
  });
});

describe("parseDocxToModel 分节与页眉页脚", () => {
  it("多节：顶层 sectPr + 段内 sectPr 切分，属性断言", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:r><w:t>第一节</w:t></w:r></w:p>
<w:sectPr>
  <w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/>
  <w:headerReference w:type="default" r:id="rIdH"/>
  <w:titlePg/>
  <w:pgNumType w:fmt="upperRoman" w:start="1"/>
</w:sectPr>
<w:p><w:r><w:t>第二节</w:t></w:r></w:p>
<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr><w:r><w:t>带分节段落</w:t></w:r></w:p>`,
      extraRels: `<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`,
      parts: [
        {
          path: "word/header1.xml",
          xml: `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉文本</w:t></w:r></w:p></w:hdr>`,
        },
      ],
    });
    const doc = await parseDocxToModel(buf);
    expect(doc.sections).toHaveLength(2);

    const s0 = doc.sections[0];
    expect(s0.pageSize).toEqual({ width: 11906, height: 16838 });
    expect(s0.pageMargins).toEqual({ top: 1440, right: 1800, bottom: 1440, left: 1800 });
    expect(s0.pageNumberFormat).toBe("upperRoman");
    expect(s0.startPageNumber).toBe(1);
    expect(s0.titlePg).toBe(true);
    expect(s0.headers).toHaveLength(1);
    expect(s0.headers[0].type).toBe("default");
    expect((s0.headers[0].blocks[0] as Paragraph).runs[0].text).toBe("页眉文本");
    expect((s0.blocks[0] as Paragraph).runs[0].text).toBe("第一节");

    const s1 = doc.sections[1];
    expect(s1.pageSize).toEqual({ width: 12240, height: 15840 });
    expect(s1.headers).toHaveLength(0);
    expect((s1.blocks[0] as Paragraph).runs[0].text).toBe("第二节");
    expect((s1.blocks[1] as Paragraph).runs[0].text).toBe("带分节段落");
  });

  it("无 sectPr → 单默认节；页脚解析", async () => {
    const buf = await makeDocx({
      bodyXml: `<w:p><w:r><w:t>正文</w:t></w:r></w:p>
<w:sectPr><w:footerReference w:type="default" r:id="rIdF"/></w:sectPr>`,
      extraRels: `<Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>`,
      parts: [
        {
          path: "word/footer1.xml",
          xml: `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>第 </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t> 页</w:t></w:r></w:p></w:ftr>`,
        },
      ],
    });
    const doc = await parseDocxToModel(buf);
    expect(doc.sections).toHaveLength(1);
    const ftr = doc.sections[0].footers[0];
    expect(ftr.blocks).toHaveLength(3);
    expect((ftr.blocks[0] as Paragraph).runs[0].text).toBe("第 ");
    expect(ftr.blocks[1]).toMatchObject({ kind: "field", type: "page" });
    expect((ftr.blocks[2] as Paragraph).runs[0].text).toBe(" 页");
  });
});

describe("parseDocxToModel 样式", () => {
  it("basedOn 继承合并：子覆盖父", async () => {
    const buf = await makeDocx({
      stylesXml: `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="24"/><w:rFonts w:ascii="宋体"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr><w:outlineLvl w:val="0"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="2F5496"/></w:rPr>
  </w:style>
</w:styles>`,
      bodyXml: `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>`,
    });
    const doc = await parseDocxToModel(buf);
    const h1 = doc.styles.get("Heading1");
    expect(h1).toMatchObject({
      id: "Heading1",
      name: "heading 1",
      basedOn: "Normal",
      outlineLevel: 0,
      align: "center",
      bold: true,
      size: 32, // 覆盖 Normal 的 24
      font: "宋体", // 从 Normal 继承
      color: "#2F5496",
    });
    const p = firstParagraph(doc);
    expect(p.style).toBe("Heading1");
  });

  it("继承环防御：不无限递归", async () => {
    const buf = await makeDocx({
      stylesXml: `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/><w:rPr><w:b/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style>
</w:styles>`,
      bodyXml: `<w:p/>`,
    });
    const doc = await parseDocxToModel(buf);
    expect(doc.styles.get("A")?.bold).toBe(true);
  });
});

describe("parseDocxToModel 错误分类", () => {
  it("非 zip → DocxParseError(not_docx)", async () => {
    await expect(parseDocxToModel(Buffer.from("not a zip at all"))).rejects.toThrow(DocxParseError);
    try {
      await parseDocxToModel(Buffer.from("not a zip at all"));
    } catch (err) {
      expect((err as DocxParseError).reason).toBe("not_docx");
    }
  });

  it("缺 document.xml → not_docx", async () => {
    const zip = new JSZip();
    zip.file("word/other.xml", "<x/>");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    try {
      await parseDocxToModel(buf);
      expect.unreachable();
    } catch (err) {
      expect((err as DocxParseError).reason).toBe("not_docx");
    }
  });
});
