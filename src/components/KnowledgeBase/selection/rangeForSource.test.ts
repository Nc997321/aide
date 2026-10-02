// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderKbMarkdown } from "../markdown";
import { rangeForSource } from "./rangeForSource";
import { scopeFromRange } from "./scopeFromRange";

function mount(source: string): HTMLElement {
  document.body.innerHTML = "";
  const body = document.createElement("div");
  body.innerHTML = renderKbMarkdown(source);
  document.body.appendChild(body);
  return body;
}

describe("rangeForSource（源文偏移 → DOM 区间）", () => {
  it("段落里的一句话 → 精确框住那几个字", () => {
    const src = "# 标题\n\n出现故障时先切流量到旧版本再排查。\n";
    const body = mount(src);
    const start = src.indexOf("切流量到旧版本");
    const r = rangeForSource(body, src, start, start + 7);
    expect(r?.toString()).toBe("切流量到旧版本");
  });

  it("跨节点（语法高亮把代码拆成多个 span）也能框准", () => {
    const src = "说明\n\n```bash\nnpm run build\nnpm test\n```\n";
    const body = mount(src);
    const start = src.indexOf("npm test");
    expect(rangeForSource(body, src, start, start + 8)?.toString()).toBe("npm test");
  });

  it("同一个词出现多次：框的是源文偏移指向的那一次", () => {
    const src = "版本一，版本二，版本三。\n";
    const body = mount(src);
    const second = src.indexOf("版本", 1);
    const r = rangeForSource(body, src, second, second + 2)!;
    expect(r.toString()).toBe("版本");
    // 它前面应当恰有一个「版本」
    const pre = document.createRange();
    pre.setStart(body.querySelector("p")!.firstChild!, 0);
    pre.setEnd(r.startContainer, r.startOffset);
    expect(pre.toString()).toBe("版本一，");
  });

  it("范围是整块（含格式）→ 退到整块", () => {
    const src = "前面 **加粗的词** 后面。\n\n别的段。\n";
    const body = mount(src);
    const r = rangeForSource(body, src, 0, "前面 **加粗的词** 后面。".length)!;
    expect(r.toString()).toBe("前面 加粗的词 后面。");
  });

  it("跨块范围 → 覆盖涉及的两块，不含第三块", () => {
    const src = "段一。\n\n段二。\n\n段三。\n";
    const body = mount(src);
    const r = rangeForSource(body, src, 0, "段一。\n\n段二。".length)!;
    expect(r.toString()).toContain("段一");
    expect(r.toString()).toContain("段二");
    expect(r.toString()).not.toContain("段三");
  });

  it("范围不在任何块里 / 空范围 → null", () => {
    const src = "段一。\n";
    const body = mount(src);
    expect(rangeForSource(body, src, 100, 120)).toBeNull();
    expect(rangeForSource(body, src, 2, 2)).toBeNull();
  });

  it("与 scopeFromRange 互逆：正向算出的范围，逆向框回同一段可见文字", () => {
    const src = "第一段。\n\n- 甲项内容\n- 乙项内容\n\n结尾段，含一个唯一词汇。\n";
    const body = mount(src);
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const i = t.data.indexOf("乙项");
      if (i < 0) continue;
      const sel = document.createRange();
      sel.setStart(t, i);
      sel.setEnd(t, i + 2);
      const res = scopeFromRange(sel, body, src);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const back = rangeForSource(body, src, res.scope.start, res.scope.end);
      expect(back?.toString()).toBe("乙项");
    }
  });
});
