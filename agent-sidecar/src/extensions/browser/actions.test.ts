// @vitest-environment node
//
// `browser_act` 的载荷脚本：**「找不到」的三种分支**是本文件的重点。
//
// 脚本是注入进页面的源码（不是本进程的函数），vitest 没有 DOM —— 这里用最小 DOM 桩把脚本跑
// 起来，断言的是**分类逻辑**（页面没有 / 有但不可见 / 有且可见但不像可点击），不是浏览器行为。
// 真实 DOM 上的行为由真页面端到端验证。
import { describe, it, expect } from "vitest";
import { buildResolveScript, type ActTarget } from "./actions.js";
import { CLICKABLE_MARKUP_SELECTOR } from "./clickable.js";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 元素桩：只实现脚本会走到的那些成员。 */
function el(tag: string, opts: { text?: string; cls?: string; rect?: Rect } = {}) {
  const rect = opts.rect ?? { left: 10, top: 20, width: 40, height: 16 };
  return {
    tagName: tag.toUpperCase(),
    textContent: opts.text ?? "",
    className: opts.cls ?? "",
    id: "",
    children: [] as unknown[],
    getBoundingClientRect: () => rect,
    getAttribute: (name: string) => (name === "class" ? (opts.cls ?? null) : null),
    scrollIntoView: () => {},
    matches: () => false,
  };
}

interface StubDom {
  document: Record<string, unknown>;
  window: Record<string, unknown>;
  NodeFilter: Record<string, unknown>;
}

/**
 * `textNodes` = 页面上**真的**带着这段文本的节点（`parentElement` 是命中元素，含不可见的）；
 * `candidates` = 候选池（能按文本定位的元素），给空才会进"找不到"分支；
 * `clickableHints` = 页面上"看起来能点"的元素（只在提示分支里用到）。
 */
function stubDom(opts: {
  candidates?: unknown[];
  textNodes?: Array<{ data: string; parentElement: unknown }>;
  clickableHints?: unknown[];
}): StubDom {
  const nodes = opts.textNodes ?? [];
  let i = 0;
  return {
    document: {
      body: {},
      querySelectorAll: (sel: string) =>
        sel === CLICKABLE_MARKUP_SELECTOR ? (opts.clickableHints ?? []) : (opts.candidates ?? []),
      createTreeWalker: () => ({
        nextNode: () => (i < nodes.length ? nodes[i++] : null),
      }),
    },
    window: {
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    },
    NodeFilter: { SHOW_TEXT: 4 },
  };
}

/** 跑一次解析脚本（形态与 runEval 送进页面的完全一致）。 */
function runResolve(target: ActTarget, dom: StubDom): Record<string, unknown> {
  const factory = new Function(
    "window",
    "document",
    "NodeFilter",
    "return " + buildResolveScript(target),
  ) as (w: unknown, d: unknown, nf: unknown) => Record<string, unknown>;
  return factory(dom.window, dom.document, dom.NodeFilter);
}

describe("browser_act：目标解析成功的那条路没变", () => {
  it("候选池里有精确匹配 → 回元素中心坐标", () => {
    const hit = el("button", { text: "刷新" });
    const out = runResolve({ text: "刷新" }, stubDom({ candidates: [hit] }));

    expect(out["ok"]).toBe(true);
    expect(out["x"]).toBe(30); // left 10 + width 40 / 2
    expect(out["y"]).toBe(28); // top 20 + height 16 / 2
    expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("button");
  });
});

describe("browser_act：「找不到」的三种分支", () => {
  it("① 页面根本没有这段文本 → 明说没有，并给一份当前能点的元素", () => {
    const dom = stubDom({ clickableHints: [el("button", { text: "刷新" })] });
    const out = runResolve({ text: "不存在的按钮" }, dom);

    expect(String(out["error"])).toContain("no element on the page contains that text");
    expect(out["candidatesKind"]).toBe("clickable");
    expect(JSON.stringify(out["candidates"])).toContain("刷新");
  });

  it("② 文本在、但全部匹配不可见 → 指向「先打开 / 先等渲染」，而不是让模型换词", () => {
    const hidden = el("div", { text: "查看", rect: { left: 0, top: 0, width: 0, height: 0 } });
    const out = runResolve(
      { text: "查看" },
      stubDom({ textNodes: [{ data: "查看", parentElement: hidden }] }),
    );

    expect(String(out["error"])).toContain("every match is hidden");
    expect(out["candidatesKind"]).toBe("text-hits");
  });

  /**
   * 这条是本次修复的主场景：`<div class="aclick">` 这类"用 div 拼的按钮"若没写
   * cursor:pointer / role / handler，就认不出**可点击**——但那不等于"页面上没有这段文本"。
   * 报错必须给出下一步（改用 selector），并带上能直接粘贴的选择器建议。
   */
  it("③ 文本在且可见，但它的元素不像可点击 → 给出 selector 建议（div.aclick）", () => {
    const plain = el("div", { text: "查看", cls: "aclick" });
    const out = runResolve(
      { text: "查看" },
      stubDom({ textNodes: [{ data: "查看", parentElement: plain }] }),
    );

    expect(String(out["error"])).toContain("recognized as clickable");
    expect(String(out["error"])).toContain("div.aclick");
    expect(out["candidatesKind"]).toBe("text-hits");
    const first = (out["candidates"] as Array<Record<string, unknown>>)[0];
    expect(first?.["tag"]).toBe("div");
    expect(first?.["cls"]).toBe("aclick");
  });
});
