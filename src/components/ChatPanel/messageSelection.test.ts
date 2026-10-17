// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readMessageSelection, SELECTION_MAX_CHARS } from "./messageSelection";

function setup(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(startNode, startOffset);
  r.setEnd(endNode, endOffset);
  sel.addRange(r);
  return sel;
}

const text = (root: HTMLElement, sel: string) => root.querySelector(sel)!.firstChild!;

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("readMessageSelection", () => {
  it("同一条消息正文里的选区：取文字、留一份 Range", () => {
    const root = setup(`<div data-msg-id="m1"><div class="msg-text"><p id="a">登录失败没有限流。</p></div></div>`);
    const t = text(root, "#a");
    const got = readMessageSelection(root, select(t, 0, t, 8));
    expect(got?.text).toBe("登录失败没有限流");
    expect(got?.range.collapsed).toBe(false);
  });

  it("跨两条消息：不认", () => {
    const root = setup(
      `<div data-msg-id="m1"><div class="msg-text"><p id="a">第一条</p></div></div>` +
        `<div data-msg-id="m2"><div class="msg-text"><p id="b">第二条</p></div></div>`,
    );
    expect(readMessageSelection(root, select(text(root, "#a"), 0, text(root, "#b"), 2))).toBeNull();
  });

  it("起点不在正文里（工具行 / 卡片）：不认", () => {
    const root = setup(`<div data-msg-id="m1"><div class="tool"><span id="t">Read file.ts</span></div></div>`);
    const t = text(root, "#t");
    expect(readMessageSelection(root, select(t, 0, t, 4))).toBeNull();
  });

  it("选区不在本面板里 / 空白选区：不认", () => {
    const root = setup(`<div data-msg-id="m1"><div class="msg-text"><p id="a">  </p></div></div>`);
    const other = setup(`<div data-msg-id="x"><div class="msg-text"><p id="o">别的面板</p></div></div>`);
    expect(readMessageSelection(root, select(text(other, "#o"), 0, text(other, "#o"), 2))).toBeNull();
    expect(readMessageSelection(root, select(text(root, "#a"), 0, text(root, "#a"), 2))).toBeNull();
  });

  it("超长截断", () => {
    const long = "字".repeat(SELECTION_MAX_CHARS + 50);
    const root = setup(`<div data-msg-id="m1"><div class="msg-text"><p id="a">${long}</p></div></div>`);
    const t = text(root, "#a");
    const got = readMessageSelection(root, select(t, 0, t, long.length));
    expect(got?.text.length).toBe(SELECTION_MAX_CHARS + 1);
    expect(got?.text.endsWith("…")).toBe(true);
  });
});
