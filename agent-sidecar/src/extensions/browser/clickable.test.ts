// @vitest-environment node
//
// 共享片段的**决策逻辑**测试。
//
// 这段代码是注入进页面的 JS 源码（不是本进程的函数），vitest 环境没有 DOM —— 所以这里用
// 桩元素把片段跑起来，只验"什么算可点击"这一判断本身：**选择器匹配交给浏览器**（桩只记录
// 它收到的是哪条选择器），真实 DOM 上的抽取行为由真页面端到端验证。
import { describe, it, expect } from "vitest";
import { CLICKABLE_JS, CLICKABLE_MARKUP_SELECTOR } from "./clickable.js";

interface ClickableHelpers {
  clickableByMarkup(el: unknown): boolean;
  clickableByStyle(el: unknown): boolean;
  isRendered(el: unknown): boolean;
}

/** 在桩环境里求值共享片段，取回三个判定函数。 */
function loadHelpers(win: unknown): ClickableHelpers {
  const factory = new Function(
    "window",
    `${CLICKABLE_JS}
     return {
       clickableByMarkup: clickableByMarkup,
       clickableByStyle: clickableByStyle,
       isRendered: isRendered
     };`,
  ) as (w: unknown) => ClickableHelpers;
  return factory(win);
}

describe("可点击判据：标记线索", () => {
  it("把**共享选择器**原样交给 el.matches（判据只有一份，别处不许再写一套）", () => {
    const seen: string[] = [];
    const el = {
      matches: (sel: string) => {
        seen.push(sel);
        return true;
      },
    };
    expect(loadHelpers({}).clickableByMarkup(el)).toBe(true);
    expect(seen).toEqual([CLICKABLE_MARKUP_SELECTOR]);
  });

  it("matches 抛异常（SVG 之类）→ false，不外抛", () => {
    const el = {
      matches: () => {
        throw new Error("nope");
      },
    };
    expect(loadHelpers({}).clickableByMarkup(el)).toBe(false);
  });

  it("没有 matches 的元素（文本节点/老运行时）→ false", () => {
    expect(loadHelpers({}).clickableByMarkup({})).toBe(false);
  });

  it("选择器覆盖四类线索：role / 内联 handler / 可聚焦 / 富交互属性", () => {
    expect(CLICKABLE_MARKUP_SELECTOR).toContain('[role="button"]');
    expect(CLICKABLE_MARKUP_SELECTOR).toContain("[onclick]");
    expect(CLICKABLE_MARKUP_SELECTOR).toContain("[tabindex]");
    expect(CLICKABLE_MARKUP_SELECTOR).toContain("[contenteditable");
    expect(CLICKABLE_MARKUP_SELECTOR).toContain("[aria-haspopup]");
    expect(CLICKABLE_MARKUP_SELECTOR).toContain("a[href]");
  });
});

describe("可点击判据：光标线索", () => {
  it("cursor:pointer → true（div 拼的按钮只有这条能认出来）", () => {
    const win = { getComputedStyle: () => ({ cursor: "pointer" }) };
    expect(loadHelpers(win).clickableByStyle({})).toBe(true);
  });

  it("cursor 是别的值 → false", () => {
    const win = { getComputedStyle: () => ({ cursor: "auto" }) };
    expect(loadHelpers(win).clickableByStyle({})).toBe(false);
  });

  it("getComputedStyle 抛异常 → false，不外抛", () => {
    const win = {
      getComputedStyle: () => {
        throw new Error("detached");
      },
    };
    expect(loadHelpers(win).clickableByStyle({})).toBe(false);
  });
});

describe("是否在渲染：有没有盒", () => {
  it("有盒 → true", () => {
    expect(loadHelpers({}).isRendered({ getClientRects: () => [1, 2] })).toBe(true);
  });

  it("没有盒（display:none 系）→ false —— 隐藏 popper / 隐藏面板靠这条挡掉", () => {
    expect(loadHelpers({}).isRendered({ getClientRects: () => [] })).toBe(false);
  });

  it("拿不到 getClientRects（老运行时）→ true（宁可多列，不可漏列）", () => {
    expect(loadHelpers({}).isRendered({})).toBe(true);
  });

  it("getClientRects 抛异常 → true", () => {
    const el = {
      getClientRects: () => {
        throw new Error("boom");
      },
    };
    expect(loadHelpers({}).isRendered(el)).toBe(true);
  });

  it("null / undefined → true（调用方不必先判空）", () => {
    expect(loadHelpers({}).isRendered(null)).toBe(true);
    expect(loadHelpers({}).isRendered(undefined)).toBe(true);
  });
});

describe("转义纪律（注入脚本的硬约束）", () => {
  it("片段里没有未求值的模板占位符", () => {
    expect(CLICKABLE_JS).not.toContain("${");
  });

  it("片段是合法 JS（转义写错会在页面上 SyntaxError，本地必须先红）", () => {
    expect(() => new Function(CLICKABLE_JS)).not.toThrow();
  });
});
