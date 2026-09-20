import { describe, it, expect } from "vitest";
import { applyTextMarks } from "./textMarks";

/** 只看结构不看属性顺序的等价比较：把标签间的空白/顺序差异抹平。 */
const norm = (s: string) => s.replace(/>\s+</g, "><");

describe("applyTextMarks（行内变更段插进高亮 HTML）", () => {
  it("没有变更段：原样返回（不解析也不重拼）", () => {
    const html = '<span class="hljs-keyword">const</span> a = 1;';

    expect(applyTextMarks(html, [], "mk")).toBe(html);
  });

  it("变更段落在纯文本上：包一层", () => {
    expect(applyTextMarks("a = 1;", [[0, 1]], "mk")).toBe('<span class="mk">a</span> = 1;');
  });

  it("变更段落在 token 内部：token 在外、变更段在里（未命中的字符各带自己的 token 壳）", () => {
    const html = '<span class="hljs-string">"abc"</span>';

    // 回拼时会重新转义（&quot;），往返后渲染结果与输入一致
    expect(applyTextMarks(html, [[1, 4]], "mk")).toBe(
      '<span class="hljs-string">&quot;</span>' +
        '<span class="hljs-string"><span class="mk">abc</span></span>' +
        '<span class="hljs-string">&quot;</span>',
    );
  });

  it("变更段跨 token 边界：两侧各自重包，嵌套仍合法", () => {
    const html = '<span class="hljs-keyword">const</span> a';

    expect(norm(applyTextMarks(html, [[0, 7]], "mk"))).toBe(
      norm(
        '<span class="hljs-keyword"><span class="mk">const</span></span>' +
          '<span class="mk"> a</span>',
      ),
    );
  });

  it("多个变更段（同一行改两处）", () => {
    const html = "a = b;";

    expect(applyTextMarks(html, [[0, 1], [4, 5]], "mk")).toBe(
      '<span class="mk">a</span> = <span class="mk">b</span>;',
    );
  });

  it("嵌套 span（xml 的 tag > name）：变更段只包住命中那层", () => {
    const html = '<span class="hljs-tag">&lt;<span class="hljs-name">div</span>&gt;</span>';

    // 纯文本是 `<div>`；标 "div" 三个字——切完每段各自带类名栈，语义与原来一致
    expect(norm(applyTextMarks(html, [[1, 4]], "mk"))).toBe(
      norm(
        '<span class="hljs-tag">&lt;</span>' +
          '<span class="hljs-tag"><span class="hljs-name"><span class="mk">div</span></span></span>' +
          '<span class="hljs-tag">&gt;</span>',
      ),
    );
  });

  it("越界/空变更段：不抛、不乱切", () => {
    expect(applyTextMarks("abc", [[10, 20]], "mk")).toBe("abc");
    expect(applyTextMarks("abc", [[1, 1]], "mk")).toBe("abc");
  });
});
