import { describe, it, expect } from "vitest";
import { highlightLines } from "./highlight";

/** 一行 HTML 里 span 是否自平衡（不平衡会让后续整段跟着变色）。 */
function balanced(html: string): boolean {
  const open = html.match(/<span\b/g)?.length ?? 0;
  const close = html.match(/<\/span>/g)?.length ?? 0;
  return open === close;
}

/** 把一行的 HTML 还原成纯文本（用于核对内容没被吃掉）。 */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

describe("highlightLines（高亮结果按行切分）", () => {
  it("行数与原文本一致，每行都是自平衡的 HTML", () => {
    const code = ["/* 块注释", "   第二行 */", "const a = 1;"].join("\n");
    const lines = highlightLines(code, "ts");

    expect(lines).toHaveLength(3);
    for (const l of lines) expect(balanced(l), `不平衡的行：${l}`).toBe(true);
    expect(lines.map(plain)).toEqual(["/* 块注释", "   第二行 */", "const a = 1;"]);
  });

  it("跨行 token 在每行都带色（整段只跑一次 hljs，行内闭合后重开）", () => {
    const lines = highlightLines(["/* 一", "   二", "   三 */"].join("\n"), "ts");

    for (const l of lines) expect(l).toContain("hljs-comment");
    // 重开的开始标签要原样带回 class，否则第二行起就没颜色了
    expect(lines[1]).toContain("hljs-comment");
    expect(lines[2]).toContain("hljs-comment");
  });

  it("嵌套 span（xml 的 tag > name）也自平衡", () => {
    const lines = highlightLines('<div class="a">\n  <span id="b">x</span>\n</div>', "html");

    expect(lines).toHaveLength(3);
    for (const l of lines) expect(balanced(l), `不平衡的行：${l}`).toBe(true);
    expect(lines[0]).toContain("hljs-tag");
    expect(lines[1]).toContain("hljs-tag");
  });

  it("未知扩展名 / 纯文本：不抛，原样转义", () => {
    const lines = highlightLines("a < b & c", "zzz");

    expect(lines).toEqual(["a &lt; b &amp; c"]);
  });

  it("末行以换行结尾时保留空行（行数与 split('\\n') 对齐）", () => {
    // 行数与 diffRows 的行模型必须同一套约定，否则行号会错位
    const lines = highlightLines("const a = 1;\n", "ts");

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("");
  });
});
