import { describe, it, expect } from "vitest";
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

/** 输出样式的 Insight 旁注块（Explanatory / Learning 下模型自绘）。
 *  识别是**猜模型意图**不是协议——宽容 + 可降级是这段的全部要点：
 *  认得出就结构化，认不出/没闭口/出现假阳性时必须原样渲染，一个字都不能丢。 */
describe("Insight 旁注块", () => {
  it("形态①定界行裸写：包成 aside，两条横线消失，正文与列表都在", () => {
    const html = renderMarkdown(
      "前言。\n\n★ Insight ─────────────────────\n旁注正文。\n- 要点一\n─────────────────────\n",
    );
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("★ Insight");
    expect(html).toContain("旁注正文。");
    expect(html).toContain("<li>要点一</li>");
    // 两条定界横线被丢掉（脚手架，不是内容）
    expect(html).not.toContain("─────");
    // 闭合横线不再被当成最后一个 li 的续行
    expect(html).not.toMatch(/<li>要点一[\s\S]*─/);
  });

  it("形态②定界行被反引号包住：同样识别", () => {
    const html = renderMarkdown(
      "`★ Insight ─────────────────`\n- 判据在**调用之后**还有没有活干。\n`─────────────────`\n",
    );
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("<strong>调用之后</strong>");
    expect(html).not.toContain("─");
  });

  it("形态③整块带 > 引用前缀：body 剥掉一层，不产生嵌套 blockquote", () => {
    const html = renderMarkdown("> ★ Insight ─────\n> 引用式旁注。\n> ─────\n");
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("引用式旁注。");
    expect(html).not.toContain("<blockquote>");
  });

  it("未闭口（流式中途 / 模型漏画）→ 包到文本末尾，内容不丢", () => {
    const html = renderStreaming("★ Insight ─────\n还在流式输出的旁注正文。");
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("还在流式输出的旁注正文。");
  });

  it("开口行自带正文：那截正文必须留下（曾整行被丢 = 吞内容）", () => {
    const html = renderMarkdown(
      "★ Insight ───────────────────── 开头这句直接跟在标签后面。\n- 要点。\n─────────────────\n",
    );
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("开头这句直接跟在标签后面。"); // ← 丢了就是回归
    expect(html).toContain("<li>要点。</li>");
  });

  it("整块压成一行：开口行里就以横线收口", () => {
    const html = renderMarkdown("★ Insight ───── 一行式的自包含旁注。 ──────────\n\n后文。\n");
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("一行式的自包含旁注。");
    expect(html).not.toContain("─");
    expect(html).toContain("<p>后文。</p>");
  });

  it("末行以横线收尾（未独占一行）：横线剥掉，正文留下", () => {
    const html = renderMarkdown("★ Insight ─────\n第一句。\n第二句。 ──────────────────\n");
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("第二句。");
    expect(html).not.toContain("─");
  });

  it("闭口行之后的内容照常渲染（marked 靠 raw.length 前进，长度错会吞/重复后文）", () => {
    const html = renderMarkdown(
      "段首。\n\n★ Insight ─────\n旁注正文。\n─────\n\n尾部段落甲。\n\n尾部段落乙。\n",
    );
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("<p>段首。</p>");
    // 后文两条都在，且旁注正文只出现一次（raw 既没吞掉后文也没把它重复吐一遍）
    expect(html).toContain("<p>尾部段落甲。</p>");
    expect(html).toContain("<p>尾部段落乙。</p>");
    expect(html.match(/旁注正文。/g)).toHaveLength(1);
  });

  it("空 body（开口紧跟闭口）：aside 为空壳，后文不受影响", () => {
    const html = renderMarkdown("★ Insight ─────\n─────\n\n后文。\n");
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("<p>后文。</p>");
  });

  it("流式实例（renderStreaming）与定稿实例走同一识别", () => {
    const html = renderStreaming("★ Insight ─────\n流式旁注。\n─────\n");
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("流式旁注。");
  });

  it("负例：正文里出现 ★ 但不是 Insight 行 → 不误判", () => {
    const html = renderMarkdown("评分 ★★★ 很高。\n\n★ 别的星号开头也不算。\n");
    expect(html).not.toContain("aide-insight");
    expect(html).toContain("评分 ★★★ 很高。");
    expect(html).toContain("★ 别的星号开头也不算。");
  });

  /** 2026-09-14 实锤：标记符号**不是固定的**。截图上那条真实消息用的是 ✶(U+2736)，
   *  而解析器当时只认 ★(U+2605)——整块静默降级成普通段落（横线留着、无样式），
   *  排查期间"手抄截图里的 ★ 去探针"把这条差异掩盖了整整一轮。
   *  下面的原文逐字取自转录（session e824e53b @2026-09-13T15:43:30Z）。 */
  it("回归：星号是 ✶(U+2736) 而非 ★ 时必须同样识别（截图那条原文）", () => {
    const html = renderMarkdown(
      "`✶ Insight ─────────────────────────────────────`\n" +
        "这个仓库的 CLAUDE.md 里也有一套「用户级约定」，那才是对**代码本身**的硬约束（层次感、参数铁律）。" +
        "Output style 约束的是我的**表达方式**，和代码质量规范是两条互不相干的线——别把「它讲得多」误当成「它写得对」。\n" +
        "`─────────────────────────────────────────────────`\n",
    );
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).toContain("<strong>代码本身</strong>"); // body 走既有渲染管线
    expect(html).not.toContain("─"); // 两条定界横线仍是脚手架
  });

  it("星号家族其他成员（✦ / ⋆ / ✧）同样识别（符号由模型自绘，不固定）", () => {
    for (const star of ["✦", "⋆", "✧"]) {
      const html = renderMarkdown(`${star} Insight ─────\n旁注正文。\n─────\n`);
      expect(html, `${star} 未识别`).toContain('<aside class="aide-insight">');
      expect(html).toContain("旁注正文。");
      expect(html).not.toContain("─");
    }
  });

  it("负例：星号不在行首（被引号/括号包住）→ 不当块起点", () => {
    const html = renderMarkdown(
      "（★ Insight 是旁注块。）\n\n「✦ Insight」同样不算。\n",
    );
    expect(html).not.toContain("aide-insight");
    expect(html).toContain("（★ Insight 是旁注块。）");
    expect(html).toContain("「✦ Insight」同样不算。");
  });

  it("负例：ASCII `*` 不收（那是 markdown 列表符，收了会改掉列表行为）", () => {
    const html = renderMarkdown("* Insight ─────\n旁注。\n─────\n");
    expect(html).not.toContain("aide-insight");
    expect(html).toContain("<li>"); // 仍是列表项
    expect(html).toContain("旁注。");
  });

  it("负例：Insightful / Insights 这类同前缀词不算（`\\b` 的唯一价值）", () => {
    for (const word of ["★ Insightful 是形容词。", "✦ Insights 是复数。"]) {
      const html = renderMarkdown(`${word}\n\n后文。\n`);
      expect(html, `${word} 被误判`).not.toContain("aide-insight");
      expect(html).toContain(word);
    }
  });

  it("负例：没有开口行的孤立横线行 → 原样保留，不被吃掉", () => {
    const src = "正文段落。\n\n─────────\n\n又一段。\n";
    const html = renderMarkdown(src);
    expect(html).not.toContain("aide-insight");
    expect(html).toContain("─────────");
    expect(html).toContain("又一段。");
  });

  it("开口行前无空行时退化成普通 markdown（已知边界，内容一字不少）", () => {
    // 无空行 → 已被段落 tokenizer 吞掉，扩展看不到块起点。刻意不定义 start
    // 换取全应用 markdown 解析不背 O(n²) 扫描（见 markdown.ts 注释）。
    const html = renderMarkdown("一段话。\n★ Insight ─────\n旁注。\n─────\n");
    expect(html).not.toContain("aide-insight");
    expect(html).toContain("一段话。");
    expect(html).toContain("旁注。");
  });

  it("XSS：旁注 body 里的裸 HTML 仍被转义（未新增注入面）", () => {
    const html = renderMarkdown(
      "★ Insight ─────\n<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n─────\n",
    );
    expect(html).toContain('<aside class="aide-insight">');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
  });
});
