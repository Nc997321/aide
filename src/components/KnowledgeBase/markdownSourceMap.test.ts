// @vitest-environment jsdom
// 渲染出的块要能精确回指存储的源文位置——圈选编辑按这个偏移改正文，错一格就是改错地方。
import { describe, expect, it } from "vitest";
import { renderKbMarkdown } from "./markdown";

/** 渲染 → 取出所有带 data-s/data-e 的元素，返回它们在源文里对应的切片（文档序）。 */
function sliced(source: string): { tag: string; slice: string }[] {
  const host = document.createElement("div");
  host.innerHTML = renderKbMarkdown(source);
  return [...host.querySelectorAll<HTMLElement>("[data-s]")].map((el) => ({
    tag: el.tagName.toLowerCase(),
    slice: source.slice(Number(el.dataset.s), Number(el.dataset.e)),
  }));
}

describe("块的源文位置 data-s / data-e", () => {
  it("段落与标题各指向自己那几行（不含换行）", () => {
    const src = "# 回滚\n\n出现故障时先切流量。\n再排查。\n\n第二段。\n";
    expect(sliced(src)).toEqual([
      { tag: "h1", slice: "# 回滚" },
      { tag: "p", slice: "出现故障时先切流量。\n再排查。" },
      { tag: "p", slice: "第二段。" },
    ]);
  });

  it("顶层列表：列表本身与每个条目都有位置，嵌套条目不另标", () => {
    const src = "前言\n\n- 甲\n- 乙\n  - 乙一\n- 丙\n\n后记";
    const got = sliced(src);
    expect(got.map((g) => g.tag)).toEqual(["p", "ul", "li", "li", "li", "p"]);
    expect(got[1]!.slice).toBe("- 甲\n- 乙\n  - 乙一\n- 丙");
    expect(got[2]!.slice).toBe("- 甲");
    expect(got[3]!.slice).toBe("- 乙\n  - 乙一");
    expect(got[4]!.slice).toBe("- 丙");
  });

  it("围栏代码块整块一个位置", () => {
    const src = "说明\n\n```bash\nnpm run build\n```\n\n结束";
    const got = sliced(src);
    expect(got.map((g) => g.tag)).toEqual(["p", "div", "p"]);
    expect(got[1]!.slice).toBe("```bash\nnpm run build\n```");
  });

  it("引用块与表格是整块", () => {
    const src = "> 引用一\n> 引用二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const got = sliced(src);
    expect(got[0]).toEqual({ tag: "blockquote", slice: "> 引用一\n> 引用二" });
    expect(got[1]!.tag).toBe("table");
    expect(got[1]!.slice).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
  });

  it("CRLF 源文：行尾的 \\r 不算进块里", () => {
    const src = "第一段\r\n\r\n第二段\r\n";
    expect(sliced(src).map((g) => g.slice)).toEqual(["第一段", "第二段"]);
  });

  it("文档站组件标签被预处理拆行，块仍回指**源文**位置（不是处理后文本的位置）", () => {
    const src = "开头\n<Note>\n  提示正文，带 `代码`\n</Note>\n结尾";
    const got = sliced(src);
    // 提示块里的段落、以及前后两段，切片都必须是源文里真实存在的原句
    expect(got.map((g) => g.slice)).toEqual(["开头", "提示正文，带 `代码`", "结尾"]);
    for (const g of got) expect(src).toContain(g.slice);
  });

  it("html 类块（组件标签残片）不标位置——选到它们时圈选要如实拒绝", () => {
    const host = document.createElement("div");
    host.innerHTML = renderKbMarkdown("<Note>\n正文\n</Note>");
    expect(host.querySelector(".kb-callout")?.hasAttribute("data-s")).toBe(false);
  });

  it("缩进不算进块里（缩进是结构，不是内容）", () => {
    const src = "   缩进三格的段落\n\n- 项\n";
    expect(sliced(src)[0]!.slice).toBe("缩进三格的段落");
  });

  it("切片逐个对得上：任意文档里，data-s/e 的切片都以该块的首个可见字开头", () => {
    const src = "## 标题甲\n\n正文甲，含 **粗体** 与 [链接](https://e.com)。\n\n1. 步骤一\n2. 步骤二\n\n---\n\n尾段";
    for (const g of sliced(src)) expect(g.slice.length).toBeGreaterThan(0);
    expect(sliced(src).find((g) => g.tag === "p")!.slice).toBe("正文甲，含 **粗体** 与 [链接](https://e.com)。");
  });

  it("空文档与纯空白不抛", () => {
    expect(sliced("")).toEqual([]);
    expect(sliced("\n\n")).toEqual([]);
  });
});
