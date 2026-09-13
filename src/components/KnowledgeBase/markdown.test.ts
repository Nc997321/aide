import { describe, expect, it } from "vitest";
import { renderKbMarkdown } from "./markdown";

describe("renderKbMarkdown 的图片协议", () => {
  it("放行 asset://（文档内嵌资源的引用形态）", () => {
    const html = renderKbMarkdown("![示意图](asset://abc-123)");

    expect(html).toContain('src="asset://abc-123"');
    expect(html).toContain('alt="示意图"');
  });

  it("放行 http/https 外链图片", () => {
    expect(renderKbMarkdown("![](https://e.com/a.png)")).toContain("https://e.com/a.png");
    expect(renderKbMarkdown("![](http://e.com/a.png)")).toContain("http://e.com/a.png");
  });

  // ── 以下是防回归：为了放行 asset:// 而放宽 safeUrl 会让它们失守 ──

  it("空 id 的 asset:// 不受放行（没有意义，当非法处理）", () => {
    const html = renderKbMarkdown("![x](asset://)");

    expect(html).not.toContain("<img");
    expect(html).toContain("x");
  });

  it("javascript: 图片仍被拒", () => {
    const html = renderKbMarkdown("![x](javascript:alert(1))");

    expect(html).not.toContain("<img");
    expect(html).toContain("x");
  });

  it("data: 图片仍被拒（Word 图片显示不出来是它造成的，但 v1 不靠放过它来修）", () => {
    const html = renderKbMarkdown("![x](data:image/png;base64,AAAA)");

    expect(html).not.toContain("<img");
  });

  it("链接的 javascript: 仍被拒（safeUrl 共用，没被放宽）", () => {
    const html = renderKbMarkdown("[点我](javascript:alert(1))");

    expect(html).not.toContain("<a href");
    expect(html).toContain("点我");
  });

  it("链接的 data: 仍被拒", () => {
    const html = renderKbMarkdown("[点我](data:text/html;base64,PHNjcmlwdD4=)");

    expect(html).not.toContain("<a href");
  });

  it("原始 HTML 仍被转义", () => {
    const html = renderKbMarkdown("<script>alert(1)</script>");

    expect(html).not.toContain("<script>");
  });
});
