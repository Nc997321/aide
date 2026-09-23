import { describe, it, expect, afterEach } from "vitest";
import type { ChatEvent } from "../../engine/types.js";
import { waitForBrowser, type WaitInput } from "./wait.js";
import { cancelAllBrowserQueries, resolveBrowserResult } from "../browserClient.js";

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

async function waitForQuery(events: ChatEvent[], n: number): Promise<any> {
  for (let i = 0; i < 500 && events.length <= n; i++) await new Promise((r) => setTimeout(r, 0));
  const q = events[n];
  if (!q) throw new Error(`bridge query #${n} never arrived (got ${events.length})`);
  return q as any;
}

function reply(q: any, body: { ok: boolean; data?: unknown; error?: string }): void {
  resolveBrowserResult({ request_id: q.request_id, ...body });
}

/** `Runtime.evaluate` 的成功回包：脚本的返回值包成 CDP 的 result 形状。 */
const evalOk = (value: unknown, type = "object") => ({
  ok: true,
  data: { view_id: "browser-1", value: { result: { type, value } } },
});

/**
 * 答一发求值请求，伪造页面那一发包装器的回包形状。
 *
 * `to` 是包装器顺带带回的 `performance.timeOrigin`——**每份文档一个值**。给了它就等于
 * 声称"这一发读的是那份文档"；不给（`undefined`）与包装器拿到 `0`/缺字段折叠出的 `null`
 * 是同一条路（"这条通道没有文档身份"）——**要考"文档被替换"就必须给**，否则两次观察都
 * 没有身份，基准建不起来，替换也就无从谈起。
 */
const tick = (q: any, body: { met?: boolean; value?: unknown; threw?: string; to?: number }) => {
  reply(
    q,
    evalOk(
      body.threw !== undefined
        ? { met: false, threw: body.threw, to: body.to }
        : { met: !!body.met, value: body.value, to: body.to },
    ),
  );
};

/** 快节奏的入参：用例只关心语义，不关心真的等 5 秒。 */
const fast = (extra: Partial<WaitInput>): WaitInput => ({
  mode: "condition",
  condition: "window.__ready",
  timeoutMs: 300,
  intervalMs: 5,
  ...extra,
});

/**
 * 一路答复桥请求直到结果落地。
 *
 * 超时用例**没法预知会轮询几次**（次数由 deadline 决定），预置答复条数必然对不上：写多了
 * `waitForQuery` 找不到那条请求，写少了测试挂死。所以边答边等。
 * 第 0 条恒为 `resolveView` 的那次求值。
 */
async function answerUntilSettled<T>(
  p: Promise<T>,
  events: ChatEvent[],
  answer: (q: any) => void,
): Promise<T> {
  let settled = false;
  const done = p.then((v) => {
    settled = true;
    return v;
  });
  reply(await waitForQuery(events, 0), evalOk(0));

  // 只有**真的答复了一条**才推进下标——否则下标会跑到事件前面去，第 1 条请求永远没人接。
  let i = 1;
  while (!settled && i < 500) {
    if (events.length > i) {
      answer(events[i]);
      i += 1;
    } else {
      await new Promise((r) => setTimeout(r, 1));
    }
  }
  return done;
}

afterEach(() => cancelAllBrowserQueries("test cleanup"));

describe("browser_wait — condition 模式", () => {
  it("条件本来就成立 → 一次轮询就回，且说的是跑的是调用方那句表达式", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({}), emit);

    const resolved = await waitForQuery(events, 0); // 解析视图那一次
    reply(resolved, evalOk(0));
    const q1 = await waitForQuery(events, 1);
    expect(q1.op).toBe("call_cdp");
    expect(q1.method).toBe("Runtime.evaluate");
    expect(q1.params.expression).toContain("window.__ready");
    tick(q1, { met: true, value: true });

    const text = await p;
    expect(text).toContain("Condition met after 1 poll");
    expect(events).toHaveLength(2);
  });

  it("前两次不成立、第三次成立 → 一直轮询到满足", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({}), emit);
    reply(await waitForQuery(events, 0), evalOk(0));

    tick(await waitForQuery(events, 1), { met: false, value: 1 });
    tick(await waitForQuery(events, 2), { met: false, value: 2 });
    tick(await waitForQuery(events, 3), { met: true, value: 3 });

    expect(await p).toContain("Condition met after 3 poll");
  });

  /**
   * 条件**抛异常不算失败**：`document.querySelector('.x').textContent` 在元素还没出现时必然抛。
   * 那是"尚未满足"，不是错误——判错了会让等待在第一次轮询就死掉。
   */
  it("条件抛异常 → 当成「还没到」继续等，并把原因留到报告里", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({}), emit);
    reply(await waitForQuery(events, 0), evalOk(0));

    tick(await waitForQuery(events, 1), { threw: "Cannot read properties of null" });
    tick(await waitForQuery(events, 2), { met: true, value: "ok" });

    const text = await p;
    expect(text).toContain("Condition met after 2 poll");
    expect(text).not.toContain("Cannot read properties");
  });

  /**
   * 但**求值本身失败**（语法错误 / 视图没了）要立即返回——求值器把条件自己的 throw 兜住了，
   * 所以走到这一层就说明问题不在条件成不成立上，等下去不会变好。烧满超时才报是把
   * "你的表达式写错了"说成"页面没反应"。
   */
  it("求值本身失败（如条件写错）→ 立即回原因，不烧满超时", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ condition: "this is not js" }), emit);
    reply(await waitForQuery(events, 0), evalOk(0));

    reply(await waitForQuery(events, 1), {
      ok: true,
      data: { value: { exceptionDetails: { text: "Uncaught SyntaxError: Unexpected identifier" } } },
    });

    const text = await p;
    expect(text).toContain("could not be evaluated");
    expect(text).toContain("SyntaxError");
    expect(events).toHaveLength(2); // 解析视图 + 这一发；**失败不重跑**
  });

  it("超时 → 回**诊断**而不是错误：轮询次数、最后观察值都在里面", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ timeoutMs: 60, intervalMs: 10 }), emit);
    const text = await answerUntilSettled(p, events, (q) => tick(q, { met: false, value: "still-no" }));

    expect(text).toContain("Timed out");
    expect(text).toContain("never became true");
    expect(text).toContain("Polled");
    expect(text).toContain("still-no");
  });

  /** 隐藏视图里依赖渲染的条件**永远不会成立**——不说这句，模型会把引擎的限制当成页面行为。 */
  it("超时诊断只说条件本身——**不再有**「视图隐藏」分支（parking 后恒 visible）", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ timeoutMs: 40, intervalMs: 10 }), emit);
    const text = await answerUntilSettled(p, events, (q) => tick(q, { met: false, value: false }));

    expect(text).toContain("Timed out");
    expect(text).toContain("never became true");
    expect(text).not.toContain("hidden");
  });

  it("视图解析失败 → 原样回 Rust 的文案（不自己发明一套解析规则）", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({}), emit);
    reply(await waitForQuery(events, 0), {
      ok: false,
      error: "no embedded browser view is open — open one in the browser panel first.",
    });

    expect(await p).toContain("open one in the browser panel first");
    expect(events).toHaveLength(1);
  });

  /**
   * ① 那个毫秒数必须是**测出来的**，不是 `attempts × intervalMs` 算出来的。
   * 2026-09-22 实测：agent 正是照抄了那个合成值（"第一次轮询 200ms 就成立"），据此建立了因果推理。
   * 构造：intervalMs 50、第一次就满足 → 合成值恒为 50ms，实测值必然远小于它。
   *
   * 正则跟着**实际发给模型的**那句走：耗时后面紧接着报的是 interval（那是两个不同的量，
   * 混起来正是这条用例要防的误读），所以捕获的是括号里第一个 `Nms`。
   */
  it("成功文案里的耗时是实测值（< intervalMs 的合成值）", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ intervalMs: 50, timeoutMs: 1000 }), emit);
    reply(await waitForQuery(events, 0), evalOk(0));
    tick(await waitForQuery(events, 1), { met: true, value: true, to: 111 });
    const m = /Condition met after 1 poll\(s\) \(([0-9]+)ms, polling every 50ms\)/.exec(await p);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(50);
  });

  it("条件求值里带出 performance.timeOrigin（免费的文档指纹）", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({}), emit);
    reply(await waitForQuery(events, 0), evalOk(0));
    const q1 = await waitForQuery(events, 1);
    expect(q1.params.expression).toContain("timeOrigin");
    tick(q1, { met: true, value: true, to: 1 });
    await p;
  });

  it("等待途中文档被替换 → 不是继续假装、也不是失败，而是如实报告并重置基准", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ timeoutMs: 400, intervalMs: 5 }), emit);
    reply(await waitForQuery(events, 0), evalOk(0));
    tick(await waitForQuery(events, 1), { met: false, value: "a", to: 111 }); // 旧文档
    tick(await waitForQuery(events, 2), { met: true, value: "b", to: 222 }); // 新文档命中
    const text = await p;
    expect(text).toContain("Condition met after 2 poll");
    expect(text).toContain("the page was replaced");
    expect(text).toContain("poll #2");
  });

  /**
   * ② 上面那条的**差分对**：唯一差别是第二跳的 `to` 与第一跳相同。
   *
   * 两条合起来才有判据——只有③（替换）会漏掉"恒报替换"的实现，只有④（同文档）会漏掉
   * "从不追踪"的实现。④单独跑是**空过**的（不报替换本来就不含这个词），所以两跳都必须
   * 带上 `to`：没有 `to` 就没有文档身份，也就没在考这件事。
   */
  it("同一文档内满足 → 不出现替换说明（不制造噪音）", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({}), emit);
    reply(await waitForQuery(events, 0), evalOk(0));
    tick(await waitForQuery(events, 1), { met: false, value: "a", to: 111 });
    tick(await waitForQuery(events, 2), { met: true, value: "b", to: 111 });
    const text = await p;
    expect(text).toContain("Condition met after 2 poll");
    expect(text).not.toContain("was replaced");
  });

  /**
   * ⑤ 超时**也是**一次终局报文：文档被换过却只字不提，等于把"我等的到底是哪个文档"重新
   * 变成不可观测——那正是本任务存在的理由。每一跳报另一个 `timeOrigin` 构造"整场都在换"。
   */
  it("超时也要如实说文档被替换过（不许只在成功时才说）", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ timeoutMs: 120, intervalMs: 10 }), emit);
    let n = 0;
    const text = await answerUntilSettled(p, events, (q) => {
      n += 1;
      tick(q, { met: false, value: n, to: 1000 + n });
    });

    expect(text).toContain("Timed out");
    expect(text).toContain("was replaced");
  });
});

describe("browser_wait — load 模式", () => {
  const views = (state: string, url = "https://a/x", visible = true) => ({
    ok: true,
    data: { views: [{ id: "browser-1", nav: { state, url, title: "" }, visible }] },
  });

  it("观察到 loading → ready → 报告加载完成", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ mode: "load" }), emit);
    reply(await waitForQuery(events, 0), evalOk(0));

    reply(await waitForQuery(events, 1), views("loading", "https://a/next"));
    reply(await waitForQuery(events, 2), views("ready", "https://a/next"));

    const text = await p;
    expect(text).toContain("Page finished loading");
    expect(text).toContain("https://a/next");
  });

  /**
   * `nav.state` **没有历史**：刚点完链接、导航还没起跳时它会说 `ready`——那是**旧页面**。
   * 静默地当成"加载完成"就是这个工具最不该犯的错（假阳性比假阴性更贵）。
   */
  it("从没观察到 loading → 如实说「本来就没在加载」，不假装等到了新页面", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ mode: "load" }), emit);
    reply(await waitForQuery(events, 0), evalOk(0));
    reply(await waitForQuery(events, 1), views("ready", "https://a/old"));

    const text = await p;
    expect(text).toContain("already ready");
    expect(text).toContain("https://a/old");
    expect(text).not.toContain("Page finished loading");
    // 同文档导航（hash 改动 / pushState）**不触发 load**，这条通道永远看不到它。
    // 不说这句，模型会把"等不到"读成"页面没动"，然后去怀疑导航本身。
    expect(text).toContain("SAME-DOCUMENT");
  });

  it("导航失败 → **立即**结束并报失败，不拖到超时", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ mode: "load" }), emit);
    reply(await waitForQuery(events, 0), evalOk(0));
    reply(await waitForQuery(events, 1), views("failed", "https://a/bad"));

    const text = await p;
    expect(text).toContain("Navigation failed");
    expect(text).toContain("https://a/bad");
    expect(events).toHaveLength(2);
  });

  it("视图还没导航过（idle）→ 立即结束并给下一步，不空等", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ mode: "load" }), emit);
    reply(await waitForQuery(events, 0), evalOk(0));
    reply(await waitForQuery(events, 1), views("idle", ""));

    const text = await p;
    expect(text).toContain("has not navigated");
    expect(text).toContain("browser_tabs");
    expect(events).toHaveLength(2);
  });

  it("等待途中视图被关掉 → 如实说视图没了，不当成还在加载", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ mode: "load" }), emit);
    reply(await waitForQuery(events, 0), evalOk(0));
    reply(await waitForQuery(events, 1), { ok: true, data: { views: [] } });

    expect(await p).toContain("is gone");
  });

  it("loading 一直不结束 → 超时诊断带上最后的状态与 URL", async () => {
    const { events, emit } = emitCollector();
    const p = waitForBrowser(fast({ mode: "load", timeoutMs: 40, intervalMs: 10 }), emit);
    const text = await answerUntilSettled(p, events, (q) => reply(q, views("loading", "https://a/slow", false)));

    expect(text).toContain("never finished loading");
    expect(text).toContain("nav.state = loading");
    expect(text).toContain("https://a/slow");
  });
});
