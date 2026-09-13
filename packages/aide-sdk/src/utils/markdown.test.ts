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

/** XSS 收口：marked 自 v5 起移除 sanitize，裸 HTML（块级 <script>/<div>、行内 <b>）
 *  在 v-html 汇点上原样进 DOM——模型吐一个 <img src=x onerror=...> 就真的执行。
 *  makeMarked 在渲染器层把 html token 转义成可见原文（默认拒绝），一处覆盖全仓
 *  marked 派生的 v-html 汇点。两个实例（marked / markedStreaming）各自独立构造，
 *  只测一个会漏掉另一个，所以两块各测一遍。见 utils/markdown.ts 的 escapedHtml。 */
describe("裸 HTML 一律转义成可见原文（XSS 收口）", () => {
  it("块级 HTML 块不产生真实标签", () => {
    const html = renderMarkdown("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("行内 HTML 标签同样被转义", () => {
    const html = renderMarkdown("前 <b>粗</b> 后");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;粗&lt;/b&gt;");
  });

  it("带事件属性的标签（常见 payload）不产生真实标签", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("流式实例（第二份独立实例）同样收口", () => {
    const html = renderStreaming("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("已知代价：合法 HTML（<details>）也变可见原文——默认拒绝的取舍，不是回归", () => {
    const html = renderMarkdown("<details><summary>x</summary>y</details>");
    expect(html).not.toContain("<details>");
    expect(html).toContain("&lt;details&gt;");
  });

  it("行内代码（codespan）本就是转义的那条路径，不得回归", () => {
    const html = renderMarkdown("用 `<script>alert(1)</script>` 这个 payload");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("回归护栏：markdown 自己生成的标签不受影响（转义的是输入 HTML，不是输出）", () => {
    const html = renderMarkdown("## 标题\n\n[链接](https://x.test)\n\n**粗**");
    expect(html).toContain("<h2");
    expect(html).toContain("<a href=");
    expect(html).toContain("<strong>粗</strong>");
  });
});

/** 链接/图片 URL 协议白名单：`javascript:` 链接在 v-html 汇点上点击即执行——
 *  ChatMessage 的 shouldOpenExternally 只管"路由到系统浏览器"，判定 false 时
 *  并不 preventDefault，浏览器默认动作照跑；另外 9 处根本没有点击拦截面。
 *  前缀白名单而非协议黑名单的原因见 utils/markdown.ts 的 SAFE_URL_PREFIXES。 */
describe("链接/图片 URL 协议白名单", () => {
  it("javascript: 链接降级为纯文本，不产生活链接", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).toContain("click");
  });

  it("实体编码的协议同样拦得住（协议黑名单拦不住的那类）", () => {
    const html = renderMarkdown("[a](&#106;avascript:alert(1))");
    expect(html).not.toContain("<a");
  });

  it("data: 链接降级", () => {
    const html = renderMarkdown("[a](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("<a href");
  });

  it("空 URL 降级（safeUrl 的空串守卫，不产生活链接）", () => {
    const html = renderMarkdown("[a]()");
    expect(html).not.toContain("<a href");
  });

  it("javascript: 图片降级为 alt 文本", () => {
    const html = renderMarkdown("![alt](javascript:alert(1))");
    expect(html).not.toContain("<img");
    expect(html).toContain("alt");
  });

  it("降级后标签内联格式仍渲染（**加粗** 不变成字面量）", () => {
    const html = renderMarkdown("[**粗**](javascript:alert(1))");
    expect(html).toContain("<strong>粗</strong>");
    expect(html).not.toContain("<a");
  });

  it("安全 URL 照常渲染（带值路径：http/https/mailto/锚点/相对路径）", () => {
    expect(renderMarkdown("[a](https://x.test)")).toContain('<a href="https://x.test"');
    expect(renderMarkdown("[a](mailto:x@y.test)")).toContain("<a href=");
    expect(renderMarkdown("[a](#sec)")).toContain("<a href=");
    expect(renderMarkdown("[a](../doc/x.md)")).toContain("<a href=");
    expect(renderMarkdown("![a](https://x.test/i.png)")).toContain("<img");
  });

  it("安全 URL 输出与 marked 默认逐字节一致（放行路径委托默认实现，不自造 markup）", () => {
    expect(renderMarkdown('[x](https://a.test "t")')).toBe(
      '<p><a href="https://a.test" title="t">x</a></p>\n',
    );
    expect(renderMarkdown('![a](https://a.test/i.png "t")')).toBe(
      '<p><img src="https://a.test/i.png" alt="a" title="t"></p>\n',
    );
  });

  it("流式实例（第二份独立实例）同样收口", () => {
    expect(renderStreaming("[a](javascript:alert(1))")).not.toContain("<a");
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
