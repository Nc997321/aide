import { describe, it, expect, beforeEach } from "vitest";
import { renderMarkdown, renderStreaming, __renderCacheSizeForTest, __renderCacheBytesForTest } from "./markdown";

/** 卡死修复的回归护栏：流式尾块渲染必须绕开 hljs（O(n²) 放大器），
 *  语法高亮只在定稿态出现。见 utils/markdown.ts 的注释与
 *  memory/aide-streaming-freeze-fix。 */
const tsFence = "回答：\n\n```typescript\nconst answer = 42;\n```\n";

describe("renderStreaming（流式尾块，不高亮）", () => {
  it("代码围栏不产生 hljs 颜色 span（剥掉卡死放大器）", () => {
    const html = renderStreaming(tsFence);
    expect(html).not.toContain("hljs-"); // 无 <span class="hljs-keyword"> 等
    expect(html).toContain("const answer = 42;"); // 内容原样转义保留
  });

  it("结构照常实时渲染（标题/加粗仍生效）", () => {
    const html = renderStreaming("## 标题\n\n**粗体**段落");
    expect(html).toContain("<h2");
    expect(html).toContain("<strong>粗体</strong>");
  });

  it("转义 HTML 元字符，不产生注入", () => {
    const html = renderStreaming("```\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderMarkdown（定稿块，高亮）", () => {
  it("同样的代码围栏在定稿态带 hljs 高亮", () => {
    const html = renderMarkdown(tsFence);
    expect(html).toContain("hljs-"); // 定稿后才补上颜色 span
    expect(html).toContain("language-typescript");
  });

  it("同一文本重复渲染返回同一引用（缓存命中）", () => {
    const text = "缓存测试 **x**";
    expect(renderMarkdown(text)).toBe(renderMarkdown(text));
  });

  it("超单条上限的大文本不入缓存（P2-2）", () => {
    renderMarkdown("小文本 **a**"); // 基线：缓存 1 条
    const before = __renderCacheSizeForTest();
    renderMarkdown("x".repeat(256 * 1024 + 1)); // > RENDER_CACHE_MAX_TEXT_CHARS
    expect(__renderCacheSizeForTest()).toBe(before); // 未入缓存，条目数不变
  });

  it("临界线下的文本仍缓存（上限边界内不受影响）", () => {
    renderMarkdown("小文本 **b**");
    const before = __renderCacheSizeForTest();
    renderMarkdown("y".repeat(256 * 1024)); // 恰好在上限内
    expect(__renderCacheSizeForTest()).toBe(before + 1);
  });

  it("总字节上限：超 8MB 按插入序淘汰到限内", () => {
    // 每条约 (100K 文本 + ≈100K html) × 2 ≈ 400KB；渲染 30 条 ≈ 12MB > 8MB 上限
    for (let i = 0; i < 30; i++) {
      renderMarkdown(`t${i}-` + "z".repeat(100 * 1024));
    }
    // 记账字节被压回限内；条数远少于 30（发生了淘汰）
    expect(__renderCacheBytesForTest()).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(__renderCacheSizeForTest()).toBeLessThan(30);
  });
});
