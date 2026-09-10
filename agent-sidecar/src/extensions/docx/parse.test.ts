import { describe, it, expect } from "vitest";
import { join } from "node:path";
import JSZip from "jszip";
import { parseDocx, classifyDocxError, resolveDocxPath, DOCX_MAX_CHARS } from "./parse.js";

/**
 * 用 jszip 内存构造最小 .docx（Word 2007+ zip 包：[Content_Types].xml + _rels/.rels +
 * word/document.xml），不落盘。自研解析器认这套结构。
 */
async function makeDocx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.folder("_rels")!.file(
    ".rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.folder("word")!.file(
    "document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("classifyDocxError", () => {
  it("zip corruption / non-docx → not_docx", () => {
    expect(classifyDocxError(new Error("Can't find end of central directory")).reason).toBe("not_docx");
    expect(classifyDocxError(new Error("not a zip file")).reason).toBe("not_docx");
    expect(classifyDocxError(new Error("invalid zip")).reason).toBe("not_docx");
  });
  it("encrypted / password → encrypted", () => {
    expect(classifyDocxError(new Error("File contains encrypted entry")).reason).toBe("encrypted");
    expect(classifyDocxError(new Error("Wrong password")).reason).toBe("encrypted");
  });
  it("other → unknown", () => {
    expect(classifyDocxError(new Error("something broke")).reason).toBe("unknown");
    expect(classifyDocxError("a string error").reason).toBe("unknown");
  });
});

describe("resolveDocxPath", () => {
  it("non-string / empty → invalid_arg", () => {
    expect(resolveDocxPath("/cwd", 123).ok).toBe(false);
    expect(resolveDocxPath("/cwd", null).ok).toBe(false);
    expect(resolveDocxPath("/cwd", "  ").ok).toBe(false);
  });
  it("verbatim \\\\?\\ prefix passthrough", () => {
    const r = resolveDocxPath("/cwd", "\\\\?\\C:\\proj\\a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("\\\\?\\C:\\proj\\a.docx");
  });
  it("absolute path direct", () => {
    const r = resolveDocxPath("/cwd", "/abs/a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("/abs/a.docx");
  });
  it("relative path joined to cwd（结果 normalize 正斜杠，bun 兼容）", () => {
    const r = resolveDocxPath("/cwd", "a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(join("/cwd", "a.docx").replace(/\\/g, "/"));
  });
});

describe("parseDocx", () => {
  it("parses paragraphs to markdown with meta", async () => {
    const buf = await makeDocx(`<w:p><w:r><w:t>Hello body</w:t></w:r></w:p>`);
    const res = await parseDocx(buf);
    expect(res.ok).toBe(true);
    if (res.ok && res.mode === "markdown") {
      expect(res.markdown).toContain("Hello body");
      expect(res.meta).toEqual({ paragraphs: 1, images: 0, tables: 0, sections: 1 });
    }
  });

  it("truncates markdown over DOCX_MAX_CHARS", async () => {
    const big = "A".repeat(DOCX_MAX_CHARS + 5000);
    const buf = await makeDocx(`<w:p><w:r><w:t>${big}</w:t></w:r></w:p>`);
    const res = await parseDocx(buf);
    expect(res.ok).toBe(true);
    if (res.ok && res.mode === "markdown") {
      expect(res.truncated).toBe(true);
      expect(res.markdown.length).toBeLessThanOrEqual(DOCX_MAX_CHARS);
    }
  });

  it("structure mode: headings/fields/sections overview", async () => {
    const buf = await makeDocx(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>正文</w:t></w:r></w:p>`,
    );
    const res = await parseDocx(buf, { mode: "structure" });
    expect(res.ok).toBe(true);
    if (res.ok && res.mode === "structure") {
      expect(res.structure.sections).toBe(1);
      expect(res.structure.paragraphs).toBe(2);
      expect(res.structure.headings).toEqual([{ level: 1, text: "第一章" }]);
    }
  });

  it("images: base64 embeds media bytes", async () => {
    const buf = await makeDocx(`<w:p><w:r><w:t>Hello body</w:t></w:r></w:p>`);
    const res = await parseDocx(buf, { images: "base64" });
    expect(res.ok).toBe(true);
    if (res.ok && res.mode === "markdown") expect(res.markdown).toContain("Hello body");
  });

  it("corrupt buffer → not ok", async () => {
    const res = await parseDocx(Buffer.from("not a zip file at all"));
    expect(res.ok).toBe(false);
  });
});