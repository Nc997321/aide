// @vitest-environment jsdom
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

describe("renderKbMarkdown 的原始 HTML 白名单", () => {
  it("导入文档里的 <h2 id> 渲染成真标题，属性（含 id）全部丢弃", () => {
    const html = renderKbMarkdown('<h2 id="behavior-notes"> 行为说明 </h2><h3 id="dual-write-architecture"> 双写架构 </h3>');

    expect(html).toContain("<h2>");
    expect(html).toContain("</h2>");
    expect(html).toContain("<h3>");
    expect(html).toContain("行为说明");
    expect(html).not.toContain("id=");
    expect(html).not.toContain("&lt;h2");
  });

  it("白名单标签带 on* / style 属性：标签留下，属性一个不留", () => {
    const html = renderKbMarkdown('<h2 onclick="alert(1)" style="x:y">t</h2>');

    expect(html).toContain("<h2>");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("style");
  });

  it("行内白名单标签（<b> / <br>）生效", () => {
    const html = renderKbMarkdown("a <b>粗</b> b<br>c");

    expect(html).toContain("<b>粗</b>");
    expect(html).toContain("<br>");
  });

  it("白名单之外的标签仍整段转义（script / iframe / img / a / 自定义组件）", () => {
    for (const src of [
      "<script>alert(1)</script>",
      '<iframe src="https://e.com"></iframe>',
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      "<Foo>提示</Foo>",
    ]) {
      const html = renderKbMarkdown(src);
      expect(html).not.toMatch(/<(script|iframe|img|a|foo)[\s>]/i);
      expect(html).toContain("&lt;");
    }
  });

  it("白名单标签与危险标签混在同一块里：只放行前者", () => {
    const html = renderKbMarkdown('<h2 id="x">t</h2><script>alert(1)</script>');

    expect(html).toContain("<h2>");
    expect(html).not.toContain("<script");
  });

  it("泛型之类的尖括号文字（Vec<T>）不被吞掉", () => {
    expect(renderKbMarkdown("返回 Vec<T> 类型")).toContain("Vec&lt;T&gt;");
  });

  it("HTML 注释静默丢弃，不当文字摆出来", () => {
    const html = renderKbMarkdown("前<!-- 备注 -->后");

    expect(html).not.toContain("备注");
    expect(html).not.toContain("&lt;!--");
  });
});

describe("renderKbMarkdown 的文档站组件标签", () => {
  it("<Note> 渲染成提示块，里面的 Markdown 照常解析（不是原文）", () => {
    const html = renderKbMarkdown("<Note>\n  带 `代码` 和 [链接](https://e.com) 的正文\n</Note>");

    expect(html).toContain('class="kb-callout kb-callout-note"');
    expect(html).toContain("<code>代码</code>");
    expect(html).toContain('<a href="https://e.com"');
    expect(html).not.toContain("&lt;Note");
    // 外框开闭配平
    expect(html.match(/<div/g)?.length).toBe(html.match(/<\/div>/g)?.length);
  });

  it("Tip / Warning 只改配色类，类名来自白名单而非文档", () => {
    expect(renderKbMarkdown("<Tip>\nx\n</Tip>")).toContain("kb-callout-tip");
    expect(renderKbMarkdown("<Warning>\nx\n</Warning>")).toContain("kb-callout-warn");
    expect(renderKbMarkdown('<Note class="evil" onclick="x()">\nx\n</Note>')).not.toMatch(/evil|onclick/);
  });

  it("写在一行里的 <Note>…</Note> 用 span，不往 <p> 里塞 div", () => {
    const html = renderKbMarkdown("<Note>一行写完</Note>");

    expect(html).toContain("<span");
    expect(html).not.toContain("<div");
    expect(html).toContain("一行写完");
  });

  it("漏写闭标签的提示块在文末补上，不留悬空外框", () => {
    const html = renderKbMarkdown("<Note>\n没闭合\n");

    expect(html.match(/<div/g)?.length).toBe(html.match(/<\/div>/g)?.length);
  });

  it("孤立的 </Note> 丢掉，不输出多余的 </div>", () => {
    expect(renderKbMarkdown("正文\n\n</Note>")).not.toContain("</div>");
  });

  it("<Steps>/<Step> 丢标签留内容；title 留成一行粗体且被转义", () => {
    const html = renderKbMarkdown('<Steps>\n<Step title="安装 & 配置">\n先装依赖\n</Step>\n</Steps>');

    expect(html).not.toMatch(/&lt;\/?Steps?/);
    expect(html).toContain("<strong>安装 &amp; 配置</strong>");
    expect(html).toContain("先装依赖");
  });

  it("属性里夹带 < > 的取巧写法不被识别成标签，整段当文字转义", () => {
    const html = renderKbMarkdown('<Step title="x <img src=1 onerror=a()>">\n正文\n</Step>');

    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;");
  });

  it("围栏代码块里的组件标签原样保留（文档在讲它，不是在用它）", () => {
    const html = renderKbMarkdown("```\n<Note>\nx\n</Note>\n```");

    expect(html).not.toContain("kb-callout");
    expect(html).toContain("&lt;Note&gt;");
  });

  it("不在名单里的大写标签（泛型 <T>、自造组件）不被吞", () => {
    expect(renderKbMarkdown("返回 Vec<T>")).toContain("Vec&lt;T&gt;");
    expect(renderKbMarkdown("<Foo>\nx\n</Foo>")).toContain("&lt;Foo&gt;");
  });

  it("HTML 表格放行，单元格属性丢弃", () => {
    const html = renderKbMarkdown('<table><tr><td style="x:y" onclick="a()">格</td></tr></table>');

    expect(html).toContain("<table>");
    expect(html).toContain("<td>格</td>");
    expect(html).not.toMatch(/style|onclick/);
  });
});

describe("renderKbMarkdown 的代码块", () => {
  it("标了语言：高亮 + 语言标签 + 复制按钮", () => {
    const html = renderKbMarkdown("```ts\nconst a = 1;\n```");

    expect(html).toContain('class="kb-code"');
    expect(html).toContain('<span class="kb-code-lang">ts</span>');
    expect(html).toContain("data-kb-copy");
    expect(html).toContain("language-ts");
    expect(html).toContain("hljs-keyword");
  });

  it("没标语言：不跑自动识别（不染色），仍有复制按钮", () => {
    const html = renderKbMarkdown("```\nconst a = 1;\n```");

    expect(html).toContain("data-kb-copy");
    expect(html).not.toContain("hljs-");
    expect(html).not.toContain("language-");
  });

  it("语言名来自文档，是不可信输入：不认识的不进 class，标签文字转义", () => {
    const html = renderKbMarkdown('```"><img src=x onerror=a()>\nx\n```');

    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain("language-");
  });

  it("代码正文里的标签仍被转义", () => {
    const html = renderKbMarkdown("```html\n<script>alert(1)</script>\n```");

    expect(html).not.toContain("<script>");
  });
});

describe("renderKbMarkdown 的文档互链 [[标题]]", () => {
  it("渲染成带标记的锚点，目标进 data 属性，没有 href", () => {
    const html = renderKbMarkdown("见 [[部署手册]] 与 [[回滚|回滚流程]]");

    expect(html).toContain('data-kb-wiki="部署手册"');
    expect(html).toContain(">部署手册</a>");
    expect(html).toContain('data-kb-wiki="回滚"');
    expect(html).toContain(">回滚流程</a>");
    expect(html).not.toContain("href=");
  });

  it("目标名来自文档，是不可信输入：转义，不能逃出属性", () => {
    const html = renderKbMarkdown('[[x" onclick="a()]]');

    // 引号被转义在属性值里；`onclick=` 只会作为链接文字出现，而不是一个活属性
    // （「不产生活的事件属性」由下面基于 DOM 的那组用例统一断言）
    expect(html).toContain('data-kb-wiki="x&quot; onclick=&quot;a()"');
  });

  it("代码里的 [[x]] 不是互链；单括号、空目标、跨行也不是", () => {
    expect(renderKbMarkdown("`[[x]]`")).not.toContain("data-kb-wiki");
    expect(renderKbMarkdown("[x]")).not.toContain("data-kb-wiki");
    expect(renderKbMarkdown("[[ ]]")).not.toContain("data-kb-wiki");
    expect(renderKbMarkdown("[[a\nb]]")).not.toContain("data-kb-wiki");
  });
});

describe("renderKbMarkdown 的属性注入（2026-10-02 实测的存储型 XSS）", () => {
  // 任何一条产出里出现「新的事件属性」就是失守：on* 必须只出现在被转义的文本里
  const hasLiveHandler = (html: string): boolean => {
    const el = document.createElement("div");
    el.innerHTML = html;
    return Array.from(el.querySelectorAll("*")).some((n) =>
      n.getAttributeNames().some((a) => a.toLowerCase().startsWith("on")),
    );
  };

  const PAYLOADS: [string, string][] = [
    ["链接 href 里的引号", '[a](https://e.com/"onmouseover="alert(1))'],
    ["链接 <> 形态的 href", '[a](<https://e.com/" onmouseover="alert(1)>)'],
    ["链接 title", '[a](https://e.com "t\\" onmouseover=\\"alert(1)")'],
    ["图片 <> 形态的 src", '![a](<https://e.com/x.png" onerror="alert(1)>)'],
    ["图片 alt", '![a" onerror="alert(1)](https://e.com/x.png)'],
    ["互链目标", '[[x" onclick="alert(1)]]'],
    ["围栏语言名", '```ts" onclick="alert(1)\nx\n```'],
  ];

  for (const [name, src] of PAYLOADS) {
    it(`${name}：不产生活的事件属性`, () => {
      expect(hasLiveHandler(renderKbMarkdown(src))).toBe(false);
    });
  }

  it("正常的带引号 title / alt 仍然被完整保留（只是被转义）", () => {
    const html = renderKbMarkdown('[a](https://e.com "say \'hi\'")');
    expect(html).toContain('href="https://e.com"');
    expect(html).toContain("&#39;hi&#39;");
  });
});

