import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { markdownToDocxBuffer, resolveDocxOutPath, DOCX_MAX_INPUT_CHARS } from "./gen.js";
import { parseDocx } from "./parse.js";

/** 1x1 透明 PNG（67 字节 base64）。 */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * round-trip：markdown → docx buffer → parseDocx 读回。
 * 断言用 toContain/正则，禁字节级快照——docx 内部 nanoid 导致同输入两次输出字节不同。
 */
async function roundTrip(md: string, opts?: Parameters<typeof markdownToDocxBuffer>[1]) {
  const res = await markdownToDocxBuffer(md, opts);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(`gen failed: ${res.detail}`);
  const back = await parseDocx(res.buffer);
  expect(back.ok).toBe(true);
  if (!back.ok) throw new Error(`parse failed: ${back.reason} ${back.detail}`);
  return { gen: res, md: back.markdown };
}

describe("markdownToDocxBuffer round-trip", () => {
  it("headings 1-6", async () => {
    const { md: out } = await roundTrip("# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6");
    expect(out).toContain("# H1");
    expect(out).toContain("## H2");
    expect(out).toContain("### H3");
    expect(out).toContain("#### H4");
    expect(out).toContain("##### H5");
    expect(out).toContain("###### H6");
  });

  it("inline bold/italic/codespan", async () => {
    const { md: out } = await roundTrip("**bold** *italic* `code`");
    expect(out).toContain("bold");
    expect(out).toContain("italic");
    expect(out).toContain("code");
  });

  it("link preserved", async () => {
    const { md: out } = await roundTrip("[example](https://example.com)");
    expect(out).toContain("example");
  });

  it("ul/ol/nested lists", async () => {
    const { md: out } = await roundTrip("- a\n- b\n\n1. one\n2. two\n\n- x\n  - y");
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).toContain("x");
    expect(out).toContain("y");
  });

  it("task list degrades to checkbox text", async () => {
    const { md: out } = await roundTrip("- [x] done\n- [ ] todo");
    expect(out).toContain("done");
    expect(out).toContain("todo");
  });

  it("table content preserved (mammoth flattens cells to paragraphs)", async () => {
    const { md: out } = await roundTrip("| 列1 | 列2 |\n| --- | --- |\n| a | b |");
    expect(out).toContain("列1");
    expect(out).toContain("列2");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("empty table cell does not crash", async () => {
    const { md: out } = await roundTrip("| a |  |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("a");
    expect(out).toContain("1");
  });

  it("code block", async () => {
    const { md: out } = await roundTrip("```js\nconst x = 1;\nconsole.log(x);\n```");
    expect(out).toContain("const x = 1;");
    // mammoth 会转义 . ( ) 等字符（markdown 语法），断言放宽到标识符
    expect(out).toContain("console");
  });

  it("blockquote and hr", async () => {
    const { md: out } = await roundTrip("> quoted text\n\n---\n\nafter");
    expect(out).toContain("quoted text");
    expect(out).toContain("after");
  });

  it("chinese mixed content", async () => {
    const { md: out } = await roundTrip("# 中文标题\n\n正文段落，包含中文标点。");
    expect(out).toContain("中文标题");
    expect(out).toContain("正文段落");
  });
});

describe("markdownToDocxBuffer images", () => {
  it("skip mode → placeholder, skippedImages counted", async () => {
    const res = await markdownToDocxBuffer("![alt text](x.png)", { images: "skip" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.images).toBe(0);
    expect(res.skippedImages).toBe(1);
    const back = await parseDocx(res.buffer);
    expect(back.ok).toBe(true);
    // mammoth 会把方括号转义成 \[]，断言放宽到内容
    if (back.ok) expect(back.markdown).toContain("image: alt text");
  });

  it("embed: local png embedded, missing file skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docxgen-"));
    writeFileSync(join(dir, "pic.png"), PNG_1X1);

    const ok = await markdownToDocxBuffer("![pic](pic.png)", { cwd: dir });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.images).toBe(1);
      expect(ok.skippedImages).toBe(0);
    }

    const miss = await markdownToDocxBuffer("![gone](missing.png)", { cwd: dir });
    expect(miss.ok).toBe(true);
    if (miss.ok) {
      expect(miss.images).toBe(0);
      expect(miss.skippedImages).toBe(1);
    }
  });

  it("URL image → placeholder (no network read)", async () => {
    const res = await markdownToDocxBuffer("![web](https://example.com/a.png)", { cwd: "/tmp" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.skippedImages).toBe(1);
  });
});

describe("markdownToDocxBuffer validation", () => {
  it("empty markdown → invalid_arg", async () => {
    const res = await markdownToDocxBuffer("");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_arg");
  });

  it("overlong markdown → invalid_arg", async () => {
    const res = await markdownToDocxBuffer("x".repeat(DOCX_MAX_INPUT_CHARS + 1));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_arg");
  });
});

describe("resolveDocxOutPath", () => {
  it("non-string / empty → invalid_arg", () => {
    expect(resolveDocxOutPath("/cwd", 123).ok).toBe(false);
    expect(resolveDocxOutPath("/cwd", null).ok).toBe(false);
    expect(resolveDocxOutPath("/cwd", "  ").ok).toBe(false);
  });
  it("verbatim \\\\?\\ prefix passthrough", () => {
    const r = resolveDocxOutPath("/cwd", "\\\\?\\C:\\proj\\a.docx");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("\\\\?\\C:\\proj\\a.docx");
  });
  it("absolute direct / relative joined to cwd", () => {
    const abs = resolveDocxOutPath("/cwd", "/abs/a.docx");
    expect(abs.ok).toBe(true);
    if (abs.ok) expect(abs.path).toBe("/abs/a.docx");
    const rel = resolveDocxOutPath("/cwd", "a.docx");
    expect(rel.ok).toBe(true);
    if (rel.ok) expect(rel.path).toBe(join("/cwd", "a.docx"));
  });
});
