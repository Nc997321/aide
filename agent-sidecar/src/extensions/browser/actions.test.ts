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
  buildFocusScript,
  buildKeyFallbackScript,
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
    id?: string;
    /** 其余属性（`placeholder` / `name` / `aria-label`）：候选行靠它把元素说清楚。 */
    attrs?: Record<string, string>;
  } = {},
) {
  return {
    tagName: tag.toUpperCase(),
    textContent: opts.text ?? "",
    className: opts.cls ?? "",
    id: opts.id ?? "",
    children: opts.children ?? [],
    parentElement: opts.parent ?? null,
    cursor: opts.cursor ?? "auto",
    getBoundingClientRect: () => opts.rect ?? { left: 10, top: 20, width: 40, height: 16 },
    getAttribute: (name: string) =>
      name === "class" ? (opts.cls ?? null) : (opts.attrs?.[name] ?? null),
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
 * `clickableHints` = 页面上"看起来能点"的元素（只在提示分支里用到）；
 * `scroll` = 文档已滚动的距离（**页面坐标**换算要用，见 buildResolveScript 的 rect）。
 */
function stubDom(opts: {
  candidates?: unknown[];
  textNodes?: Array<{ data: string; parentElement: unknown }>;
  clickableHints?: unknown[];
  scroll?: { x: number; y: number };
  /** 页面当前聚焦的元素（按键脚本读它）。缺省 null = 什么都没聚焦。 */
  activeElement?: unknown;
}): StubDom {
  const nodes = opts.textNodes ?? [];
  let i = 0;
  return {
    document: {
      body: {},
      activeElement: opts.activeElement ?? null,
      // 脚本读滚动偏移时会先看 window.pageXOffset，再退回 documentElement——两个都要在桩里，
      // 缺一个就是解引用 undefined 抛异常，而异常会被脚本的 try 折成"resolve failed"，
      // 让**所有**解析用例静默变成失败分支。
      documentElement: { scrollLeft: 0, scrollTop: 0 },
      querySelectorAll: (sel: string) =>
        sel === CLICKABLE_MARKUP_SELECTOR ? (opts.clickableHints ?? []) : (opts.candidates ?? []),
      createTreeWalker: () => ({
        nextNode: () => (i < nodes.length ? nodes[i++] : null),
      }),
    },
    window: {
      pageXOffset: opts.scroll?.x ?? 0,
      pageYOffset: opts.scroll?.y ?? 0,
      // 按键兜底脚本走 `window.KeyboardEvent`（真页面就是它）；桩里给一个只留 type 的最小实现。
      KeyboardEvent: class {
        constructor(public type: string) {}
      },
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
function runResolve(
  target: ActTarget,
  dom: StubDom,
  opts?: { scroll?: boolean },
): Record<string, unknown> {
  const factory = new Function(
    "window",
    "document",
    "NodeFilter",
    "return " + buildResolveScript(target, opts),
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

/**
 * `rect` 是**页面坐标**矩形（`browser_screenshot` 拿它当 CDP 的 `clip`），`x`/`y` 是**视口**坐标
 * （CDP `Input.dispatchMouseEvent` 的口径）——两套口径同时出现在一个载荷里，正是要钉的地方。
 */
describe("buildResolveScript：页面坐标矩形与 scroll 开关", () => {
  it("rect 含滚动偏移（页面坐标），x/y 仍是视口坐标（点击口径）", () => {
    const hit = el("button", { text: "刷新", markup: true });
    const out = runResolve({ text: "刷新" }, stubDom({ candidates: [hit], scroll: { x: 100, y: 200 } }));

    expect(out["ok"]).toBe(true);
    // 视口相对：left 10 + width 40 / 2 = 30（滚动与否都不该变）
    expect(out["x"]).toBe(30);
    expect(out["y"]).toBe(28);
    // 页面坐标：视口坐标 + 滚动偏移 —— CDP 的 clip 相对**文档原点**，不是视口
    expect(out["rect"]).toEqual({ x: 110, y: 220, w: 40, h: 16 });
  });

  it("缺省（点击路径）会 scrollIntoView —— 元素不在视口里也点得到", () => {
    const calls: unknown[] = [];
    const hit = el("button", { text: "刷新", markup: true });
    hit.scrollIntoView = (arg?: unknown) => calls.push(arg);

    const out = runResolve({ text: "刷新" }, stubDom({ candidates: [hit] }));

    expect(out["ok"]).toBe(true);
    // 必须带 `instant`：smooth 是动画，同一次脚本里读到的 rect 会是滚动前的旧值
    expect(calls).toEqual([{ block: "center", inline: "center", behavior: "instant" }]);
  });

  it("scroll:false（截图路径）**不碰**元素滚动位置，照样给 rect", () => {
    const calls: unknown[] = [];
    const hit = el("button", { text: "刷新", markup: true });
    hit.scrollIntoView = (arg?: unknown) => calls.push(arg);

    const out = runResolve({ text: "刷新" }, stubDom({ candidates: [hit] }), { scroll: false });

    expect(out["ok"]).toBe(true);
    expect(calls).toEqual([]); // 用户正在看的滚动位置不许被动
    expect(out["rect"]).toEqual({ x: 10, y: 20, w: 40, h: 16 });
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
 * `selector` 多命中：**默认取 index 0 是个易错猜测**（2026-09-29 真机走查实锤：宽 selector 把值
 * 灌进了另一个控件的搜索框，工具只加了一句注脚）。文本匹配的多命中**不在此列**——它的池子按
 * 「最具体」排序，index 0 有语义；selector 的池子是文档序，第一个没有任何理由。
 */
describe("browser_act：selector 多命中不许替调用方猜", () => {
  const inputs = () => [
    el("input", { attrs: { placeholder: "故障类型", name: "faultType" } }),
    el("input", { attrs: { placeholder: "委外单位", name: "vendor" } }),
    el("input", { attrs: { placeholder: "备注", name: "memo" } }),
  ];

  it("未给 index → 失败 + 候选清单（含 placeholder，让模型一眼挑对）", () => {
    const out = runResolve({ selector: "input" }, stubDom({ candidates: inputs() }));

    expect(out["ok"]).toBe(false);
    expect(String(out["error"])).toContain("matched 3 elements");
    expect(out["candidatesKind"]).toBe("selector-matches");
    const cands = out["candidates"] as Array<Record<string, unknown>>;
    expect(cands.length).toBe(3);
    expect(JSON.stringify(cands)).toContain("故障类型");
    expect(JSON.stringify(cands)).toContain("faultType");
  });

  it("显式 index:0 → 照旧成功（要第一个是合法表达，只是必须说出来）", () => {
    const out = runResolve({ selector: "input", index: 0 }, stubDom({ candidates: inputs() }));

    expect(out["ok"]).toBe(true);
    expect(out["usedIndex"]).toBe(0);
  });

  it("只命中一个 → 不报歧义", () => {
    const out = runResolve({ selector: "input" }, stubDom({ candidates: inputs().slice(0, 1) }));

    expect(out["ok"]).toBe(true);
  });

  it("文本多命中不受影响（池子已按最具体排序，index 0 是语义而不是猜测）", () => {
    const a = el("div", { text: "保存", cursor: "pointer" });
    const b = el("div", { text: "保存", cursor: "pointer" });
    const out = runResolve({ text: "保存" }, stubDom({ candidates: [a, b] }));

    expect(out["ok"]).toBe(true);
  });
});

/** 跑一次设值脚本。 */
function runFill(target: ActTarget, value: string, dom: StubDom): Record<string, unknown> {
  const factory = new Function(
    "window",
    "document",
    "NodeFilter",
    "return " + buildFillScript(target, value),
  ) as (w: unknown, d: unknown, nf: unknown) => Record<string, unknown>;
  return factory(dom.window, dom.document, dom.NodeFilter);
}

/** 跑任意一段（按键那两条脚本与解析脚本共用同一个出口）。 */
function runScript(script: string, dom: StubDom): Record<string, unknown> {
  const factory = new Function(
    "window",
    "document",
    "NodeFilter",
    "return " + script,
  ) as (w: unknown, d: unknown, nf: unknown) => Record<string, unknown>;
  return factory(dom.window, dom.document, dom.NodeFilter);
}

/**
 * 表单元素桩。`revertTo` 模拟**受控组件**：写进去的值被改回去（React 的受控 input、EP 的部分
 * 封装都会这样），这正是「看起来填上了、提交时是空的」那类事故的最小形态。
 */
function field(
  tag: string,
  opts: {
    type?: string;
    value?: string;
    revertTo?: string;
    attrs?: Record<string, string>;
    disabled?: boolean;
    readOnly?: boolean;
  } = {},
) {
  const e = el(tag, { attrs: opts.attrs }) as Record<string, unknown>;
  let stored = opts.value ?? "";
  Object.defineProperty(e, "value", {
    get: () => stored,
    set: (v: unknown) => {
      stored = opts.revertTo === undefined ? String(v) : opts.revertTo;
    },
  });
  const events: string[] = [];
  e["type"] = opts.type;
  e["disabled"] = opts.disabled;
  e["readOnly"] = opts.readOnly;
  e["events"] = events;
  e["focus"] = () => {};
  e["dispatchEvent"] = (ev: { type: string }) => {
    events.push(ev.type);
    return true;
  };
  return e;
}

/**
 * fill 的三条新纪律（2026-09-29 走查反馈）：① 派发了哪些事件要说；② **值真落了才叫 Set**
 * （读回校验）；③ 根本不是表单元素时不许假成功（现在的实现会给它挂一个 expando 属性然后报成功）。
 */
describe("browser_act fill：值真的落了吗", () => {
  it("文本输入：派发 input+change，并读回确认值落住", () => {
    const e = field("input", { attrs: { name: "faultType" } });
    const out = runFill({ selector: "input" }, "电压异常", stubDom({ candidates: [e] }));

    expect(out["ok"]).toBe(true);
    expect(out["value"]).toBe("电压异常");
    expect(e["events"]).toEqual(["input", "change"]);
  });

  it("受控组件把值改回去 → 如实报读回值 + 不报成功", () => {
    const e = field("input", { revertTo: "" });
    const out = runFill({ selector: "input" }, "电压异常", stubDom({ candidates: [e] }));

    expect(out["ok"]).toBe(false);
    expect(String(out["error"])).toContain("reads back");
    expect(String(out["error"])).toContain("电压异常");
  });

  it("非表单元素（contenteditable 这类）→ 拒绝并指路，不写 expando 属性", () => {
    const div = el("div", { text: "正文", attrs: { contenteditable: "" } });
    const out = runFill({ selector: "div" }, "电压异常", stubDom({ candidates: [div] }));

    expect(out["ok"]).toBe(false);
    expect(String(out["error"])).toContain("not an input, textarea or select");
    expect((div as Record<string, unknown>)["value"]).toBeUndefined();
  });

  it("disabled 控件 → 拒绝（页面不会收这个值）", () => {
    const e = field("input", { disabled: true });
    const out = runFill({ selector: "input" }, "x", stubDom({ candidates: [e] }));

    expect(out["ok"]).toBe(false);
    expect(String(out["error"])).toContain("disabled");
  });
});

/**
 * fill 按 `text` 找的是**字段**（2026-10-07 agent 实测反馈）：输入框没有自己的文字，旧路径只认
 * 元素文字 → 落到 notFound → 列一份可点元素，跟要找的输入框不是一类。
 */
describe("browser_act fill：按字段名找、找不到列字段", () => {
  it("按 name 精确命中（输入框没有文字，旧路径找不到它）", () => {
    const other = field("input", { attrs: { name: "username" } });
    const cred = field("input", { attrs: { name: "satoken" } });
    const out = runFill({ text: "satoken" }, "abc", stubDom({ candidates: [other, cred] }));

    expect(out["ok"]).toBe(true);
    expect(cred["value"]).toBe("abc");
    expect(other["value"]).toBe("");
  });

  it("按 placeholder 包含命中；精确优先于包含", () => {
    const loose = field("input", { attrs: { placeholder: "请输入 token 前缀" } });
    const exact = field("input", { attrs: { placeholder: "token" } });
    const out = runFill({ text: "token" }, "t", stubDom({ candidates: [loose, exact] }));

    expect(out["ok"]).toBe(true);
    expect(exact["value"]).toBe("t");
  });

  it("找不到 → 候选列的是页面上的**字段**（带 name/placeholder），不是可点元素", () => {
    const a = field("input", { attrs: { name: "cred", placeholder: "粘贴凭据" } });
    const btn = el("button", { text: "提交", markup: true });
    const out = runFill(
      { text: "satoken" },
      "x",
      stubDom({ candidates: [a], clickableHints: [btn] }),
    );

    expect(out["ok"]).toBe(false);
    expect(out["candidatesKind"]).toBe("fields");
    expect(String(out["error"])).toContain("no form field is named");
    const c = (out["candidates"] as Record<string, unknown>[])[0];
    expect(c).toMatchObject({ tag: "input", name: "cred", placeholder: "粘贴凭据" });
  });

  it("selector 歧义那份候选照旧（下一步是给 index，不是换字段）", () => {
    const a = field("input"), b = field("input");
    const out = runFill({ selector: "input" }, "x", stubDom({ candidates: [a, b] }));

    expect(out["candidatesKind"]).toBe("selector-matches");
  });
});

/**
 * 按键（`action:"press"`）的两条脚本：**键落在谁身上**必须先确定，再交给 CDP 派发。
 * 没给目标时按 `activeElement` 走（"fill 之后按回车"就是这个形状），而**页面上什么都没聚焦**
 * 必须如实失败——发一个没人接的键，回来就是"按了没反应"的幽灵故障。
 */
describe("browser_act press：按键落在谁身上", () => {
  it("给了目标 → 聚焦它，并把命中的元素报回来", () => {
    const e = el("input", { attrs: { name: "q" } }) as Record<string, unknown>;
    let focused = false;
    e["focus"] = () => {
      focused = true;
    };

    const out = runScript(buildFocusScript({ selector: "input" }), stubDom({ candidates: [e] }));

    expect(out["ok"]).toBe(true);
    expect(focused).toBe(true);
    expect((out["hit"] as Record<string, unknown>)["tag"]).toBe("input");
  });

  it("没给目标 → 用当前 activeElement（fill 之后那个字段）", () => {
    const e = el("input", { attrs: { name: "q" } });
    const out = runScript(buildFocusScript({}), stubDom({ activeElement: e }));

    expect(out["ok"]).toBe(true);
    expect((out["hit"] as Record<string, unknown>)["name"]).toBe("q");
  });

  it("没给目标且页面上没有任何焦点（body）→ 失败并指路，不发键", () => {
    const dom = stubDom({ activeElement: null });
    (dom.document as Record<string, unknown>)["activeElement"] = (
      dom.document as Record<string, unknown>
    )["body"];

    const out = runScript(buildFocusScript({}), dom);

    expect(out["ok"]).toBe(false);
    expect(String(out["error"])).toContain("nothing is focused");
  });

  it("合成兜底：keydown + keyup 都派发到同一个元素，仍报它（不是可信事件由调用方说）", () => {
    const e = el("input", { attrs: { name: "q" } }) as Record<string, unknown>;
    const seen: string[] = [];
    e["dispatchEvent"] = (ev: { type: string }) => {
      seen.push(ev.type);
      return true;
    };

    const out = runScript(
      buildKeyFallbackScript({ selector: "input" }, "Enter", "Enter", []),
      stubDom({ candidates: [e] }),
    );

    expect(out["ok"]).toBe(true);
    expect(seen).toEqual(["keydown", "keyup"]);
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

  it("按键的两条脚本都是合法 JS", () => {
    expect(() => new Function(buildFocusScript(target))).not.toThrow();
    expect(() => new Function(buildKeyFallbackScript(target, "Enter", "Enter", ["ctrl"]))).not.toThrow();
  });
});
