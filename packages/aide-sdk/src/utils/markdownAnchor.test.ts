// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderMarkdown, handleMarkdownAnchorClick } from "./markdown";

describe("handleMarkdownAnchorClick：只在给定容器内找带前缀的标题", () => {
  function setup(md: string) {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(md);
    document.body.appendChild(root);
    const scrolled: string[] = [];
    root.querySelectorAll<HTMLElement>("[id]").forEach((el) => {
      el.scrollIntoView = () => scrolled.push(el.id);
    });
    return { root, scrolled };
  }
  function click(root: HTMLElement, href: string) {
    const a = document.createElement("a");
    a.setAttribute("href", href);
    root.appendChild(a);
    const e = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "target", { value: a });
    return { handled: handleMarkdownAnchorClick(e, root), prevented: e.defaultPrevented };
  }

  it("目录锚点滚到对应标题；锚点写法与 slug 不完全一致也能对上", () => {
    const { root, scrolled } = setup("## 九、批次模型版本（锁定与显式升级）\n\n## Foo Bar");
    expect(click(root, "#九批次模型版本锁定与显式升级")).toEqual({ handled: true, prevented: true });
    expect(click(root, "#Foo Bar").handled).toBe(true);
    expect(scrolled).toEqual(["md-九批次模型版本锁定与显式升级", "md-foo-bar"]);
  });

  it("非锚点链接不接管，留给调用方", () => {
    const { root } = setup("## A");
    expect(click(root, "https://example.com")).toEqual({ handled: false, prevented: false });
  });

  it("不会跳到前缀外的应用元素", () => {
    const { root, scrolled } = setup("text");
    const appEl = document.createElement("div");
    appEl.id = "config";
    appEl.scrollIntoView = () => scrolled.push("config");
    root.appendChild(appEl);
    click(root, "#config");
    expect(scrolled).toEqual([]);
  });
});
