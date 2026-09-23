// @vitest-environment node
//
// `browser_act` 的载荷脚本：「找不到」的三种分支 + **可点过滤**是本文件的重点。
//
// 脚本是注入进页面的源码（不是本进程的函数），vitest 没有 DOM —— 这里用最小 DOM 桩把脚本跑
// 起来，断言的是**分类/过滤逻辑**，不是浏览器行为。真实 DOM 上的行为由真页面端到端验证
// （`docs/testing/browser-read-fixture.html`）——2026-09-22 正是那一页逮到"宽候选池让第三分支
// 够不着"，而当时的单测喂了真实 DOM 产生不出的 `candidates: []`。
//
// ⚠️ 桩里的 `matches` 是**显式声明**（`markup: true`）而不是选择器引擎：`button`/`a[href]`/
// `[role=button]`/`[onclick]` 这些线索在真实 DOM 里由 CSS 选择器判定，桩只表达"这个元素带线索"。
// 所以代表真控件的桩必须写 `markup: true` —— 漏写会静默变成"不可点"，用例会红在那条上。
import { describe, it, expect } from "vitest";
import {
  buildClickFallbackScript,
  buildFillScript,
  buildResolveScript,
  type ActTarget,
} from "./actions.js";
import { CLICKABLE_MARKUP_SELECTOR } from "./clickable.js";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 元素桩：只实现脚本会走到的那些成员。 */
function el(
  tag: string,
  opts: {
    text?: string;
    cls?: string;
    rect?: Rect;
    /** 带可点**标记**线索（标签/role/属性）——真实 DOM 由 CSS 选择器判，桩里显式声明。 */
    markup?: boolean;
    /** 计算出的 cursor 值（`pointer` = 光标线索）。 */
    cursor?: string;
    parent?: unknown;
    children?: unknown[];
  } = {},
) {
  return {
    tagName: tag.toUpperCase(),
    textContent: opts.text ?? "",
    className: opts.cls ?? "",
    id: "",
    children: opts.children ?? [],
    parentElement: opts.parent ?? null,
    cursor: opts.cursor ?? "auto",
    getBoundingClientRect: () => opts.rect ?? { left: 10, top: 20, width: 40, height: 16 },
    getAttribute: (name: string) => (name === "class" ? (opts.cls ?? null) : null),
    scrollIntoView: () => {},
    matches: () => opts.markup === true,
  };
}

interface StubDom {
  document: Record<string, unknown>;
  window: Record<string, unknown>;
  NodeFilter: Record<string, unknown>;
}

/**
 * `candidates` = 候选池（**文本载体**：裸 div/span/td 也在里面）；
 * `textNodes` = 页面上真的带着这段文本的节点（`parentElement` 是命中元素）；
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
      getComputedStyle: (e: { cursor?: string }) => ({
        visibility: "visible",
        display: "block",
        opacity: "1",
        cursor: e?.cursor ?? "auto",
      }),
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

describe("browser_act：目标解析成功的那条路", () => {
  it("候选池里有精确匹配 → 回元素中心坐标", () => {
    const hit = el("button", { text: "刷新", markup: true });
    const out = runResolve({ text: "刷新" }, stubDom({ candidates: [hit] }));

    expect(out["ok"]).toBe(true);
    expect(out["x"]).toBe(30); // left 10 + width 40 / 2
    expect(out["y"]).toBe(28); // top 20 + height 16 / 2
    expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("button");
  });

  it("裸 div 与真按钮并存 → 挑真按钮（不可点的那堆直接不参与）", () => {
    const plain = el("div", { text: "刷新", cls: "plain" });
    const btn = el("button", { text: "刷新", markup: true });
    const out = runResolve({ text: "刷新" }, stubDom({ candidates: [plain, btn] }));

    expect(out["ok"]).toBe(true);
    expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("button");
  });

  /**
   * 文字装在子元素里、线索在祖先上（`<div role="button"><span>保存</span></div>`）——
   * 点是靠冒泡生效的，所以"祖先可点"必须算数，否则这类会被误拒。
   */
  it("祖先带可点线索 → 子元素里的文字也点得到（取最内层的那个）", () => {
    const wrapper = el("div", { text: "保存", markup: true });
    const span = el("span", { text: "保存", parent: wrapper });
    wrapper.children = [span];
    const out = runResolve({ text: "保存" }, stubDom({ candidates: [wrapper, span] }));

    expect(out["ok"]).toBe(true);
    expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("span");
  });

  it("光标线索（cursor:pointer）也算可点 —— 用 div 拼的按钮靠它", () => {
    const fake = el("div", { text: "查看", cursor: "pointer" });
    const out = runResolve({ text: "查看" }, stubDom({ candidates: [fake] }));

    expect(out["ok"]).toBe(true);
    expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("div");
  });
});

describe("browser_act：「找不到」的三种分支", () => {
  it("① 页面根本没有这段文本 → 明说没有，并给一份当前能点的元素", () => {
    const dom = stubDom({ clickableHints: [el("button", { text: "刷新", markup: true })] });
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
   * 这条是**真机夹具逮到的那条**（2026-09-22）：真实 DOM 里 `<div class="plain">` **就在**
   * 候选池里（池子是宽集合），旧实现因此走成功路径、直接点了上去——第三分支在真页面上够不着。
   * 现在池子里有它也得拒：它不带任何可点线索，自己与祖先都不是"能点"的。
   */
  it("③ 池子里有裸 div（可见、文本也对）→ 仍然报「不像可点击」并给 div.plain", () => {
    const plain = el("div", { text: "纯文本块", cls: "plain" });
    const out = runResolve(
      { text: "纯文本块" },
      stubDom({
        candidates: [plain],
        textNodes: [{ data: "纯文本块", parentElement: plain }],
      }),
    );

    expect(String(out["error"])).toContain("recognized as clickable");
    expect(String(out["error"])).toContain("div.plain");
    expect(out["candidatesKind"]).toBe("text-hits");
    const first = (out["candidates"] as Array<Record<string, unknown>>)[0];
    expect(first?.["tag"]).toBe("div");
    expect(first?.["cls"]).toBe("plain");
  });
});

/**
 * EP 把双字按钮渲染成「确　定」（中间是空白）——归一化把空白折成单空格后，`确定` 既不等于
 * 也不包含它。反馈第 3 条逐字一致：真按钮**从没进过候选池**，命中的是包含"确定"的文案。
 */
describe("browser_act：CJK 空白容错", () => {
  const cases: [string, string][] = [
    ["半角空格", "确 定"],
    ["全角空格 U+3000", "确　定"],
    ["换行", "确\n定"],
  ];

  for (const [name, label] of cases) {
    // 测试名里的换行会把报告撕成两行（`换行` 那条就是）——只折给**名字**看，喂脚本的仍是原字符。
    it(`${name}：{text:"确定"} 命中 <button>"${label.replace(/\n/g, "\\n")}"</button>`, () => {
      const btn = el("button", { text: label, markup: true });
      const copy = el("p", { text: "确定通过审核？" });
      const out = runResolve({ text: "确定" }, stubDom({ candidates: [btn, copy] }));

      expect(out["ok"]).toBe(true);
      expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("button");
    });
  }

  it("调用方带空白（{text:\"确 定\"}）也命中同一个按钮", () => {
    const btn = el("button", { text: "确　定", markup: true });
    const out = runResolve({ text: "确 定" }, stubDom({ candidates: [btn] }));

    expect(out["ok"]).toBe(true);
    expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("button");
  });

  /** 「找不到」分支的候选清单也要容错，否则失败信息与匹配规则自相矛盾。 */
  it("textHits 也容错（按钮不可点时报出的候选里有它）", () => {
    const plain = el("div", { text: "确　定", cls: "plain" });
    const out = runResolve(
      { text: "确定" },
      stubDom({ candidates: [plain], textNodes: [{ data: "确　定", parentElement: plain }] }),
    );

    expect(out["candidatesKind"]).toBe("text-hits");
    expect(JSON.stringify(out["candidates"])).toContain("确");
    // 上面那句只钉"清单里出现这个字"——钉住**是不是那个元素**（换个容器也含「确」就测不出回归）。
    const first = (out["candidates"] as Array<Record<string, unknown>>)[0];
    expect(first?.["cls"]).toBe("plain");
    expect(String(first?.["text"])).toBe("确 定");
  });
});

/**
 * 命中数早就在解析结果里（`matched`），只是没人读；`index` 越界被 `Math.min` 悄悄改成别的元素
 * 也从不说——模型以为自己点的是自己说的那个。报数**必须带"实际用了哪个"**，否则 `matched` 那
 * 个数字反而在帮着撒谎。
 */
describe("browser_act：命中歧义报数", () => {
  it("解析结果带出 usedIndex，且是 Math.min 钳制之后的值", () => {
    const a = el("div", { text: "保存", cursor: "pointer" });
    const b = el("div", { text: "保存", cursor: "pointer" });
    const out = runResolve({ text: "保存", index: 9 }, stubDom({ candidates: [a, b] }));

    expect(out["ok"]).toBe(true);
    expect(out["matched"]).toBe(2);
    expect(out["usedIndex"]).toBe(1); // 请求 index 9 → 钳到最后一个，**且要说出来**
  });
});

/**
 * 转义纪律（注入脚本的硬约束；同款一组见 `clickable.test.ts`）。
 *
 * 解析脚本每个用例都在跑（`runResolve` 就是 `new Function`），另**两个**脚本此前没有任何测试
 * 把它们当 JS 解析——转义写错只会在真页面里 SyntaxError。这类错本批就栽过两次（注入注释里的
 * 反引号撕开外层模板字面量，`actions.ts` 整个文件解析不过）。
 */
describe("browser_act：注入脚本的转义纪律", () => {
  const target: ActTarget = { text: "刷新" };

  it("设值脚本是合法 JS", () => {
    expect(() => new Function(buildFillScript(target, "x"))).not.toThrow();
  });

  it("兜底点击脚本是合法 JS", () => {
    expect(() => new Function(buildClickFallbackScript(target))).not.toThrow();
  });
});
