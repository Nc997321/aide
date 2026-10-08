// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { renderKbMarkdown } from "../markdown";
import { scopeFromRange } from "./scopeFromRange";

let body: HTMLElement;
function mount(source: string): void {
  document.body.innerHTML = "";
  body = document.createElement("div");
  body.className = "kb-body";
  body.innerHTML = renderKbMarkdown(source);
  document.body.appendChild(body);
}
beforeEach(() => {
  document.body.innerHTML = "";
});

/** 在渲染页里按「可见文字」选一段：needle 在正文可见文字（跨文本节点拼接，不含代码块工具条）里的第 nth 次出现。
 *  语法高亮会把一行代码拆成很多 <span>，所以必须跨节点找。 */
function select(needle: string, nth = 0): Range {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement?.closest(".kb-code-bar, [data-kb-copy]")) nodes.push(n as Text);
  }
  const joined = nodes.map((n) => n.data).join("");
  let at = -1;
  for (let i = 0, from = joined.indexOf(needle); from !== -1; from = joined.indexOf(needle, from + 1), i++) {
    if (i === nth) {
      at = from;
      break;
    }
  }
  if (at < 0) throw new Error(`没找到 ${needle}`);
  const locate = (offset: number): [Text, number] => {
    let acc = 0;
    for (const n of nodes) {
      if (offset <= acc + n.data.length) return [n, offset - acc];
      acc += n.data.length;
    }
    throw new Error("offset 越界");
  };
  const r = document.createRange();
  const [sn, so] = locate(at);
  const [en, eo] = locate(at + needle.length);
  r.setStart(sn, so);
  r.setEnd(en, eo);
  return r;
}

/** 跨节点选区：从 a 的开头到 b 的结尾。 */
function selectAcross(a: string, b: string): Range {
  const r = select(a);
  const end = select(b);
  r.setEnd(end.endContainer, end.endOffset);
  return r;
}

const SRC = "# 回滚\n\n出现故障时先切流量到旧版本再排查。\n\n第二段不能动，连标点都不能动。\n";

describe("scopeFromRange · 精确档", () => {
  it("段落里选半句话 → 范围就是这半句，源文切片与所选文字一致", () => {
    mount(SRC);
    const r = scopeFromRange(select("切流量到旧版本"), body, SRC);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scope.precise).toBe(true);
    expect(r.scope.text).toBe("切流量到旧版本");
    expect(SRC.slice(r.scope.start, r.scope.end)).toBe("切流量到旧版本");
    expect(r.scope.lineStart).toBe(3);
    expect(r.scope.lineEnd).toBe(3);
  });

  it("同一个词在块里出现多次：按它在页面上是第几次出现，落到源文里同一个位置", () => {
    const src = "版本一，版本二，版本三。\n";
    mount(src);
    const r = scopeFromRange(select("版本", 1), body, src);
    expect(r.ok && r.scope.precise).toBe(true);
    if (!r.ok) return;
    expect(r.scope.start).toBe(src.indexOf("版本", src.indexOf("版本") + 1));
    expect(src.slice(r.scope.start, r.scope.end)).toBe("版本");
  });

  it("选区首尾有空白：范围不含空白", () => {
    mount(SRC);
    const r = scopeFromRange(select(" 切流量到旧版本 ".trim()), body, SRC);
    expect(r.ok && r.scope.text).toBe("切流量到旧版本");
  });

  it("选的是代码块里的文字：只在 <pre> 内对位，不被语言标签/复制按钮干扰", () => {
    const src = "说明\n\n```bash\nnpm run build\nnpm test\n```\n";
    mount(src);
    const r = scopeFromRange(select("npm test"), body, src);
    expect(r.ok && r.scope.precise).toBe(true);
    if (!r.ok) return;
    expect(src.slice(r.scope.start, r.scope.end)).toBe("npm test");
  });

  it("整个落在加粗内部的选区仍然精确——替换只动这几个字，两侧的 ** 原样保留", () => {
    const src = "前面 **加粗的词** 后面。\n";
    mount(src);
    const r = scopeFromRange(select("加粗的词"), body, src);
    expect(r.ok && r.scope.precise).toBe(true);
    if (!r.ok) return;
    expect(src.slice(r.scope.start, r.scope.end)).toBe("加粗的词");
    expect(src.slice(0, r.scope.start).endsWith("**")).toBe(true);
  });

  it("列表条目里选一句 → 精确", () => {
    const src = "- 甲项内容\n- 乙项内容\n";
    mount(src);
    const r = scopeFromRange(select("乙项"), body, src);
    expect(r.ok && r.scope.precise).toBe(true);
    if (!r.ok) return;
    expect(src.slice(r.scope.start, r.scope.end)).toBe("乙项");
  });
});

describe("scopeFromRange · 整块档（宁可扩大，不猜）", () => {
  it("选区跨过加粗标记：渲染文字与源文对不上 → 扩大到整个段落并标 precise=false", () => {
    const src = "前面 **加粗的词** 后面。\n\n别的段。\n";
    mount(src);
    const r = scopeFromRange(select("前面 加粗的词"), body, src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scope.precise).toBe(false);
    expect(r.scope.text).toBe("前面 **加粗的词** 后面。");
  });

  it("跨两个段落 → 两段整块，且不含中间以外的内容", () => {
    const src = "段一。\n\n段二。\n\n段三。\n";
    mount(src);
    const r = scopeFromRange(selectAcross("段一", "段二"), body, src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scope.precise).toBe(false);
    expect(r.scope.text).toBe("段一。\n\n段二。");
    expect(r.scope.text).not.toContain("段三");
  });

  it("三击选段（结束点落在下一块开头）不会把下一块算进来", () => {
    const src = "第一段。\n\n第二段。\n";
    mount(src);
    const p1 = body.querySelectorAll("p")[0]!;
    const p2 = body.querySelectorAll("p")[1]!;
    const r = document.createRange();
    r.setStart(p1.firstChild!, 0);
    r.setEnd(p2, 0); // 浏览器三击的典型形状
    const got = scopeFromRange(r, body, src);
    expect(got.ok && got.scope.text).toBe("第一段。");
  });

  it("同一个词在块里出现多次、但源文里标记让次数对不上 → 退到整块而不是猜一个位置", () => {
    const src = "词 **词** 词\n";
    mount(src);
    const r = scopeFromRange(select("词", 1), body, src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scope.precise === true ? src.slice(r.scope.start, r.scope.end) : r.scope.text).toBeTruthy();
    // 无论走哪一档，范围都必须落在源文里，且文本与源文逐字一致
    expect(src.slice(r.scope.start, r.scope.end)).toBe(r.scope.text);
  });
});

describe("scopeFromRange · 拒绝", () => {
  it("折叠选区 → empty", () => {
    mount(SRC);
    const r = document.createRange();
    r.setStart(body.querySelector("p")!.firstChild!, 2);
    r.collapse(true);
    expect(scopeFromRange(r, body, SRC)).toEqual({ ok: false, reason: "empty" });
  });

  it("只选了空白 → empty", () => {
    mount("甲 乙\n");
    const t = body.querySelector("p")!.firstChild as Text;
    const r = document.createRange();
    r.setStart(t, 1);
    r.setEnd(t, 2);
    expect(scopeFromRange(r, body, "甲 乙\n")).toEqual({ ok: false, reason: "empty" });
  });

  it("选区在正文容器之外 → outside", () => {
    mount(SRC);
    const other = document.createElement("p");
    other.textContent = "外面的字";
    document.body.appendChild(other);
    const r = document.createRange();
    r.selectNodeContents(other);
    expect(scopeFromRange(r, body, SRC)).toEqual({ ok: false, reason: "outside" });
  });

  it("选到没有源文位置的区域（组件标签残片）→ unlocatable，不退化成猜", () => {
    const src = "<Note>\n</Note>\n";
    mount(src);
    body.insertAdjacentHTML("beforeend", '<div class="kb-callout"><span id="x">残片文字</span></div>');
    const r = document.createRange();
    r.selectNodeContents(body.querySelector("#x")!);
    expect(scopeFromRange(r, body, src)).toEqual({ ok: false, reason: "unlocatable" });
  });
});
