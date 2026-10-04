// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installTitleTooltips } from "./tooltip";

const tips = () => document.querySelectorAll(".aide-tooltip");

function over(el: Element) {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 10, clientY: 10 }));
}
function leaveWindow(el: Element) {
  el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: null }));
}

describe("原生 title → 主题化提示", () => {
  let uninstall: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    uninstall = installTitleTooltips();
  });
  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  it("悬停时摘掉 title（原生提示不弹）、延时后显示主题提示；离开后还回 title", () => {
    document.body.innerHTML = `<button id="b" title="新建">+</button>`;
    const b = document.getElementById("b")!;

    over(b);
    expect(b.hasAttribute("title")).toBe(false);
    expect(tips()).toHaveLength(0);

    vi.advanceTimersByTime(500);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toBe("新建");

    leaveWindow(b);
    expect(tips()).toHaveLength(0);
    expect(b.getAttribute("title")).toBe("新建");
  });

  it("从一个元素移到另一个：前者还原，后者接管", () => {
    document.body.innerHTML = `<button id="a" title="甲">a</button><button id="b" title="乙">b</button>`;
    const a = document.getElementById("a")!;
    const b = document.getElementById("b")!;

    over(a);
    vi.advanceTimersByTime(500);
    over(b);
    expect(a.getAttribute("title")).toBe("甲");
    expect(b.hasAttribute("title")).toBe(false);
    vi.advanceTimersByTime(500);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toBe("乙");
  });

  it("在元素内部的无 title 子节点间移动不会闪", () => {
    document.body.innerHTML = `<div id="d" title="整行"><span id="s1">x</span><span id="s2">y</span></div>`;
    over(document.getElementById("s1")!);
    vi.advanceTimersByTime(500);
    over(document.getElementById("s2")!);
    expect(tips()).toHaveLength(1);
    expect(tips()[0].textContent).toBe("整行");
  });

  it("更近的带 title 子元素优先；回到外层时外层重新接管", () => {
    document.body.innerHTML = `<div id="o" title="外层"><button id="i" title="内层">i</button><span id="t">t</span></div>`;
    const o = document.getElementById("o")!;
    const i = document.getElementById("i")!;

    over(o);
    over(i);
    expect(o.getAttribute("title")).toBe("外层");
    vi.advanceTimersByTime(500);
    expect(tips()[0].textContent).toBe("内层");

    over(document.getElementById("t")!);
    expect(i.getAttribute("title")).toBe("内层");
    vi.advanceTimersByTime(500);
    expect(tips()[0].textContent).toBe("外层");
  });

  it("悬停期间 title 被框架改写：提示跟着换，原生提示仍不弹，离开后留新值", async () => {
    document.body.innerHTML = `<button id="b" title="旧">b</button>`;
    const b = document.getElementById("b")!;
    over(b);
    vi.advanceTimersByTime(500);

    b.setAttribute("title", "新");
    await vi.waitFor(() => expect(b.hasAttribute("title")).toBe(false));
    expect(tips()[0].textContent).toBe("新");

    leaveWindow(b);
    expect(b.getAttribute("title")).toBe("新");
  });

  it("挂了 v-tooltip 的元素（data-aide-tooltip）在内层时，不叠加祖先的 title", () => {
    document.body.innerHTML = `<div id="o" title="外层"><button id="v" data-aide-tooltip>v</button></div>`;
    const o = document.getElementById("o")!;
    over(document.getElementById("v")!);
    vi.advanceTimersByTime(500);
    expect(tips()).toHaveLength(0);
    expect(o.getAttribute("title")).toBe("外层");
  });

  it("按下鼠标收起提示", () => {
    document.body.innerHTML = `<button id="b" title="新建">+</button>`;
    const b = document.getElementById("b")!;
    over(b);
    vi.advanceTimersByTime(500);
    b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(tips()).toHaveLength(0);
  });
});
