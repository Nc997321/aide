// @vitest-environment node
//
// recorder 是**注入进页面的源码字符串**，vitest 没有 DOM —— 这里用最小桩把源码跑起来，
// 断言的是 recorder 自己的契约（幂等 / 不改页面行为 / 有界 / 如实标截断），
// 真实页面上的行为由真机夹具（docs/testing/browser-recorder-fixture.html）验。
//
// ⚠️ 桩 console 必须传进去：源码里是裸 `console[lvl] = …`，不 shadow 就会改到 vitest 自己的 console。
import { describe, it, expect, afterEach } from "vitest";
import type { ChatEvent } from "../../engine/types.js";
import { cancelAllBrowserQueries, resolveBrowserResult } from "../browserClient.js";
import {
  RECORDER_SOURCE,
  RECORDER_CAP,
  RECORDER_TEXT_CAP,
  buildRecorderReadScript,
  readRecorder,
} from "./recorder.js";

// ⚠️ 下半场（`readRecorder`）走**真桥客户端**：Rust 那一侧用 `resolveBrowserResult` 顶掉，
// 于是"发了几次注册、几时发的"这些节奏断言是端到端的，不是对着桩猜的。
afterEach(() => cancelAllBrowserQueries("test cleanup"));

type Handlers = Record<string, Function[]>;

/** 页面 window 的最小桩：只需要 `addEventListener` + 被测代码会用到的那几个成员。 */
function makeWindow(over: Record<string, unknown> = {}) {
  const handlers: Handlers = {};
  const win: any = {
    addEventListener: (t: string, fn: Function) => {
      (handlers[t] ||= []).push(fn);
    },
    ...over,
  };
  return { win, handlers };
}

/** 以**表达式**形态跑源码（与注入路径一致：`ExecuteScript` / `Runtime.evaluate` 都收表达式）。 */
function run(source: string, win: any, consoleStub: any, perf: any = { now: () => 42 }) {
  const factory = new Function("window", "console", "performance", "return " + source);
  return factory(win, consoleStub, perf);
}

/** 一个永不 settle 的 fetch 桩（验 pending 用）。 */
const neverFetch = () => new Promise(() => {});

function fetchStub(opts: {
  status?: number;
  body?: string;
  len?: string | null;
  ctype?: string;
  reject?: string;
  /** 体**不该**被读时用它：`clone()` 一被调用就炸（证明"读没发生"，而不是"回了个字符串"）。 */
  cloneThrows?: string;
}) {
  return () => {
    if (opts.reject) return Promise.reject(new Error(opts.reject));
    const res = {
      status: opts.status ?? 200,
      headers: {
        get: (h: string) =>
          h === "content-length" ? (opts.len ?? null) : h === "content-type" ? (opts.ctype ?? null) : null,
      },
      clone: () => {
        if (opts.cloneThrows) throw new Error(opts.cloneThrows);
        return { text: () => Promise.resolve(opts.body ?? "") };
      },
    };
    return Promise.resolve(res);
  };
}

/** 让挂起的微任务跑完（recorder 读体是 clone().text() 上的 then）。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("recorder 源码：语法与转义", () => {
  it("是可解析的表达式，且模板占位符已求值", () => {
    expect(() => new Function("return " + RECORDER_SOURCE)).not.toThrow();
    expect(RECORDER_SOURCE).not.toContain("${");
    expect(RECORDER_SOURCE).toContain(`cap: ${RECORDER_CAP}`);
  });
});

describe("recorder：幂等与不改页面行为", () => {
  it("装两次只有一个缓冲（第二次不套娃）", () => {
    const { win } = makeWindow({ fetch: fetchStub({ body: "{}" }) });
    const c = { log: () => {} };
    expect(run(RECORDER_SOURCE, win, c)).toBe("armed");
    const first = win.__aideRec;
    expect(run(RECORDER_SOURCE, win, c)).toBe("already armed");
    expect(win.__aideRec).toBe(first);
  });

  it("fetch 失败仍然抛给调用方（recorder 不改页面行为）", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ reject: "boom" }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await expect(win.fetch("http://x/api")).rejects.toThrow("boom");
    expect(win.__aideRec.reqs[0].err).toBe("boom");
    expect(win.__aideRec.reqs[0].done).toBe(true);
  });

  it("console 包装仍然转发给原实现", () => {
    const seen: unknown[] = [];
    const c = { warn: (...a: unknown[]) => seen.push(a) };
    const { win } = makeWindow();
    run(RECORDER_SOURCE, win, c);

    c.warn("hi", { n: 1 });

    expect(seen).toHaveLength(1); // 原实现照常被调
    expect(win.__aideRec.logs[0].lvl).toBe("warn");
    expect(win.__aideRec.logs[0].text).toContain("hi");
  });
});

describe("recorder：有界与如实标截断", () => {
  it("响应体被 slice 时如实标 cut 与原始长度", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ body: "z".repeat(RECORDER_TEXT_CAP + 50) }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await win.fetch("http://x/api");
    await flush();

    const rec = win.__aideRec.reqs[0];
    expect(rec.bodyCut).toBe(true);
    expect(rec.body).toHaveLength(RECORDER_TEXT_CAP);
    expect(rec.bodyLen).toBe(RECORDER_TEXT_CAP + 50);
  });

  /**
   * ⚠️ skip 走 `bodyNote` **不是** `err`：`err` 只装"这条请求失败了"。写进 err 会让读脚本的
   * 失败计数把一条 200 算成失败，摘要行——agent 最先看的那行——就在最要紧的路径上撒谎
   * （真机判据 4 的 finding D）。这条同时钉住"没读体"仍然如实标出来。
   */
  it("content-length 超闸门 → 不读体，如实标 bodyNote（err 保持 null）", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ len: String(300 * 1024), body: "z" }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await win.fetch("http://x/api");
    await flush();

    const rec = win.__aideRec.reqs[0];
    expect(rec.body).toBeNull();
    expect(rec.bodyNote).toBe(`body skipped (${300 * 1024} bytes)`);
    expect(rec.err).toBeNull();
    expect(rec.done).toBe(true);
    // 跳过的体仍然如实报"没读到"：正文空、长度 0、没截断
    expect(rec.bodyCut).toBe(false);
    expect(rec.bodyLen).toBe(0);
  });

  /**
   * 事件流**永不结束**：`clone().text()` 会把整条流一路攒在页面内存里（本产品自己的 API 就是这个
   * 形状），而且没有 `content-length` 给闸门看。所以按 `content-type` 单独跳过。
   *
   * 这条测的是"**读没发生**"，不是"回了个字符串"：`clone()` 被调用即抛，若走了读体那条路，
   * `err` 会是那句抛出的文案（差一步就绿）。
   */
  it("content-type 是事件流 → 不读体，如实标 skipped（不是静默留空）", async () => {
    const { win } = makeWindow({
      fetch: fetchStub({
        ctype: "text/event-stream; charset=utf-8",
        body: "data: never\n\n",
        cloneThrows: "clone() must not be called for an event stream",
      }),
    });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await win.fetch("http://x/events");
    await flush();

    const rec = win.__aideRec.reqs[0];
    expect(rec.body).toBeNull();
    expect(rec.bodyNote).toBe("body skipped (event stream)");
    expect(rec.err).toBeNull();
    expect(rec.done).toBe(true);
  });

  it("未结束的请求 done=false（渲染层据此报 pending）", () => {
    const { win } = makeWindow({ fetch: neverFetch });
    run(RECORDER_SOURCE, win, { log: () => {} });
    win.fetch("http://x/slow");
    expect(win.__aideRec.reqs[0].done).toBe(false);
  });

  it("环形缓冲不超 cap，且丢的是最旧的", () => {
    const { win } = makeWindow({ fetch: neverFetch });
    run(RECORDER_SOURCE, win, { log: () => {} });
    for (let i = 0; i < RECORDER_CAP + 10; i++) win.fetch("http://x/" + i);

    expect(win.__aideRec.reqs).toHaveLength(RECORDER_CAP);
    expect(win.__aideRec.reqs[RECORDER_CAP - 1].url).toBe("http://x/" + (RECORDER_CAP + 9));
  });

  it("console 行被 slice 时也带 cut 与原始长度", () => {
    const { win } = makeWindow();
    const c = { log: (_msg: string) => {} };
    run(RECORDER_SOURCE, win, c);

    c.log("y".repeat(RECORDER_TEXT_CAP + 7));

    const entry = win.__aideRec.logs[0];
    expect(entry.cut).toBe(true);
    expect(entry.text).toHaveLength(RECORDER_TEXT_CAP);
    expect(entry.len).toBe(RECORDER_TEXT_CAP + 7);
  });
});

describe("recorder：请求体（脱敏 + 截断）", () => {
  function armed() {
    const { win } = makeWindow({ fetch: fetchStub({ body: "{}" }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    return win;
  }

  it("JSON 体：照原样记录字段名，凭据类键（含嵌套）一律 [redacted]", async () => {
    const win = armed();
    await win.fetch("http://x/api/publish", {
      method: "POST",
      body: JSON.stringify({ toPublish: true, user: { password: "hunter2", satoken: "abc", author: "me" } }),
    });
    const rec = win.__aideRec.reqs[0];
    expect(rec.reqBody).toContain('"toPublish":true');
    expect(rec.reqBody).toContain('"author":"me"');
    expect(rec.reqBody).not.toContain("hunter2");
    expect(rec.reqBody).not.toContain("abc");
    expect(rec.reqBody).toContain('"password":"[redacted]"');
  });

  it("urlencoded 体与 URLSearchParams：按键脱敏", async () => {
    const win = armed();
    await win.fetch("http://x/login", { method: "POST", body: "username=bob&pwd=s3cret" });
    await win.fetch("http://x/login", { method: "POST", body: new URLSearchParams({ a: "1", access_token: "t" }) });
    expect(win.__aideRec.reqs[0].reqBody).toBe("username=bob&pwd=[redacted]");
    expect(win.__aideRec.reqs[1].reqBody).toBe("a=1&access_token=[redacted]");
  });

  it("超长体如实标 reqCut 与原长；没有体就是 null", async () => {
    const win = armed();
    const big = JSON.stringify({ data: "x".repeat(2000) });
    await win.fetch("http://x/big", { method: "POST", body: big });
    await win.fetch("http://x/get");
    const [a, b] = win.__aideRec.reqs;
    expect(a.reqCut).toBe(true);
    expect(a.reqLen).toBe(big.length);
    expect(b.reqBody).toBeNull();
  });

  it("XHR send(body) 同样记录", () => {
    class FakeXHR {
      open() {}
      send() {}
      addEventListener() {}
    }
    const { win } = makeWindow({ XMLHttpRequest: FakeXHR });
    run(RECORDER_SOURCE, win, { log: () => {} });
    const x = new (win.XMLHttpRequest as any)();
    x.open("POST", "http://x/api");
    x.send('{"secret":"s","id":1}');
    expect(win.__aideRec.reqs[0].reqBody).toBe('{"secret":"[redacted]","id":1}');
  });

  it("读脚本把 reqBody 带进 items", async () => {
    const win = armed();
    await win.fetch("http://x/api", { method: "POST", body: '{"a":1}' });
    const out = run(buildRecorderReadScript({ kind: "reqs", limit: 10 }), win, { log: () => {} });
    expect(out.items[0]).toMatchObject({ reqBody: '{"a":1}', reqCut: false });
  });
});

describe("recorder：XHR 包装", () => {
  it("open/send 被记录，loadend 时补上状态码与响应体", () => {
    // 最小 XHR 桩：只实现 recorder 会碰的那些成员。
    const listeners: Record<string, Function[]> = {};
    class FakeXHR {
      status = 200;
      responseText = '{"ok":true}';
      open(_m: string, _u: string) {}
      send() {}
      addEventListener(t: string, fn: Function) {
        (listeners[t] ||= []).push(fn);
      }
      getResponseHeader() {
        return null;
      }
    }
    const { win } = makeWindow({ XMLHttpRequest: FakeXHR });
    run(RECORDER_SOURCE, win, { log: () => {} });

    const x = new (win.XMLHttpRequest as any)();
    x.open("POST", "http://x/api");
    x.send();

    const rec = win.__aideRec.reqs[0];
    expect(rec.kind).toBe("xhr");
    expect(rec.method).toBe("POST");
    expect(rec.done).toBe(false);

    for (const fn of listeners["loadend"] ?? []) fn();

    expect(rec.status).toBe(200);
    expect(rec.body).toBe('{"ok":true}');
    expect(rec.done).toBe(true);
  });

  /** XHR 的第三个 skip 站点与 fetch 同口径：走 `bodyNote`，`err` 保持 null。 */
  it("XHR 的 content-length 超闸门 → bodyNote 而非 err", () => {
    const listeners: Record<string, Function[]> = {};
    class FakeXHR {
      status = 200;
      responseText = "z".repeat(10);
      open(_m: string, _u: string) {}
      send() {}
      addEventListener(t: string, fn: Function) {
        (listeners[t] ||= []).push(fn);
      }
      getResponseHeader(name: string) {
        return name === "content-length" ? String(300 * 1024) : null;
      }
    }
    const { win } = makeWindow({ XMLHttpRequest: FakeXHR });
    run(RECORDER_SOURCE, win, { log: () => {} });

    const x = new (win.XMLHttpRequest as any)();
    x.open("GET", "http://x/big");
    x.send();
    for (const fn of listeners["loadend"] ?? []) fn();

    const rec = win.__aideRec.reqs[0];
    expect(rec.bodyNote).toBe(`body skipped (${300 * 1024} bytes)`);
    expect(rec.err).toBeNull();
    expect(rec.body).toBeNull();
    expect(rec.done).toBe(true);
  });
});

describe("recorder：没接住的错误", () => {
  it("未捕获异常与未处理拒绝各进一条 logs（lvl 分开，不混进 console.error）", () => {
    const { win, handlers } = makeWindow();
    run(RECORDER_SOURCE, win, { log: () => {} });

    handlers["error"][0]({ message: "Uncaught ReferenceError: nope is not defined" });
    handlers["unhandledrejection"][0]({ reason: { message: "nope" } });

    expect(win.__aideRec.logs.map((l: any) => l.lvl)).toEqual(["uncaught", "unhandled"]);
    expect(win.__aideRec.logs[0].text).toContain("nope is not defined");
  });
});

// ---- 读脚本：筛选 / 计数 / 条数（决定模型**真正看到**什么的那一半在页面侧） ----

/** 一个「已经装上」的 window：缓冲预填好，注入源码自己会 `return 'already armed'` 走开。 */
function armedWindow(rec: { reqs?: unknown[]; logs?: unknown[] }) {
  const { win } = makeWindow({
    __aideRec: { reqs: rec.reqs ?? [], logs: rec.logs ?? [], cap: RECORDER_CAP },
  });
  return win;
}

/** 跑读脚本、取回信封。`performance.now` 固定 1000，好让未结束条目的 `ms` 可算。 */
function readEnvelope(opts: { kind: "reqs" | "logs"; limit: number; match?: string }, win: any) {
  return run(buildRecorderReadScript(opts), win, { log: () => {} }, { now: () => 1000 }) as any;
}

/** 一条网络记录（只写用例关心的字段，其余给默认值）。 */
function req(over: Record<string, unknown> = {}) {
  return {
    kind: "fetch",
    method: "GET",
    url: "https://a/x",
    status: 200,
    done: true,
    ms: 3,
    t: 1,
    body: null,
    bodyCut: false,
    bodyLen: 0,
    err: null,
    bodyNote: null,
    ...over,
  };
}

/** 一条 console 记录。 */
function line(over: Record<string, unknown> = {}) {
  return { lvl: "log", t: 1, text: "x", cut: false, len: 1, ...over };
}

describe("recorder 读脚本：筛选 / 计数 / 条数", () => {
  it("URL 子串筛选：只有匹配的进 items，matched 是筛后的条数", () => {
    const win = armedWindow({
      reqs: [
        req({ url: "https://a/api/1" }),
        req({ url: "https://a/static/x.js" }),
        req({ url: "https://a/api/2" }),
      ],
    });

    const v = readEnvelope({ kind: "reqs", limit: 10, match: "api" }, win);

    expect(v.total).toBe(3);
    expect(v.matched).toBe(2);
    expect(v.items.map((i: any) => i.url)).toEqual(["https://a/api/1", "https://a/api/2"]);
  });

  it("console 的 error 档含 uncaught / unhandled；all 与省略都不过滤", () => {
    const win = armedWindow({
      logs: [
        line({ lvl: "log" }),
        line({ lvl: "error" }),
        line({ lvl: "uncaught" }),
        line({ lvl: "unhandled" }),
        line({ lvl: "warn" }),
      ],
    });

    const errors = readEnvelope({ kind: "logs", limit: 10, match: "error" }, win);
    expect(errors.items.map((i: any) => i.lvl)).toEqual(["error", "uncaught", "unhandled"]);

    expect(readEnvelope({ kind: "logs", limit: 10, match: "all" }, win).matched).toBe(5);
    expect(readEnvelope({ kind: "logs", limit: 10 }, win).matched).toBe(5);
    expect(readEnvelope({ kind: "logs", limit: 10, match: "warn" }, win).matched).toBe(1);
  });

  it("limit 取**最新**的 N 条（从尾部切）", () => {
    const win = armedWindow({ reqs: [1, 2, 3, 4, 5].map((n) => req({ url: `https://a/${n}` })) });

    const v = readEnvelope({ kind: "reqs", limit: 2 }, win);

    expect(v.items.map((i: any) => i.url)).toEqual(["https://a/4", "https://a/5"]);
    // 窗口之外还有 3 条：模型靠 matched/total 知道"这不是全部"
    expect(v.matched).toBe(5);
    expect(v.total).toBe(5);
  });

  it("failed 只数**已结束**的失败；first 是 matched 里的序号（1 起）", () => {
    const win = armedWindow({
      reqs: [
        req({ url: "https://a/ok" }),
        req({ url: "https://a/500", status: 500 }),
        req({ url: "https://a/pending", status: 500, done: false, ms: null }),
        req({ url: "https://a/neterr", status: null, err: "boom" }),
      ],
    });

    const v = readEnvelope({ kind: "reqs", limit: 10 }, win);

    // 未结束那条**不算**失败（状态码还没定），但照样列出来：done:false + 已经过了多少毫秒
    expect(v.failed).toEqual({ n: 2, first: 2 });
    const pending = v.items.find((i: any) => i.url.endsWith("pending"));
    expect(pending.done).toBe(false);
    expect(pending.ms).toBe(999); // nowMs(1000) - t(1)
  });

  /**
   * 真机判据 4 的 finding D：`/api/big` 回 200 + 体被体积闸门跳过，摘要行却报
   * `⚠ 1 of 1 matches failed`——一条成功的请求被数成失败，而摘要行正是 agent 最先看的那行。
   *
   * 根因是 skip 曾经写进 `err`（读脚本把 `!!err` 当失败）。这条把新口径钉死：**200 + 跳过体
   * 不算失败**，而"没读体"这个事实照样进 items（不许用"不报失败"换掉"如实标跳过"）。
   */
  it("200 + 体被跳过（bodyNote）→ **不算失败**，但 bodyNote 照样进 items", () => {
    const win = armedWindow({
      reqs: [req({ url: "https://a/api/big", status: 200, bodyNote: "body skipped (307220 bytes)" })],
    });

    const v = readEnvelope({ kind: "reqs", limit: 10 }, win);

    expect(v.failed).toEqual({ n: 0, first: null }); // ← 修复前是 {n: 1, first: 1}
    expect(v.matched).toBe(1);
    expect(v.items[0].bodyNote).toBe("body skipped (307220 bytes)");
    expect(v.items[0].err).toBeNull();
    // 形状照旧诚实：没读体 = 正文空 / 长度 0 / 没截断
    expect(v.items[0].body).toBeNull();
    expect(v.items[0].bodyLen).toBe(0);
    expect(v.items[0].bodyCut).toBe(false);
    expect(v.items[0].done).toBe(true);
  });

  /**
   * 同一个缺陷的**接缝**版本：缺陷横跨两半（源码写字段 / 读脚本数字段），各自单测都能绿，
   * 所以再来一条端到端的——用**真源码**产出一条被闸门跳过的 200，直接喂给读脚本，
   * 断言那个数字。真机那条路径（300KB 端点 + `filter:"/api/big"`）就是这一条。
   */
  it("端到端：闸门跳过的 200 走完源码 → 读脚本，failed.n 仍是 0", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ len: "307220", body: "z" }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await win.fetch("http://127.0.0.1:8780/api/big");
    await flush();

    const v = readEnvelope({ kind: "reqs", limit: 10, match: "/api/big" }, win);

    expect(v.matched).toBe(1); // 缓冲里就这一条
    expect(v.failed).toEqual({ n: 0, first: null }); // ← 修复前 {n: 1, first: 1}
    expect(v.items[0].bodyNote).toBe("body skipped (307220 bytes)");
    expect(v.items[0].err).toBeNull();
  });

  it("非有限的 limit 不再静默回空表（Infinity/NaN 按「要全部」夹，负数夹到 0）", () => {
    const win = armedWindow({ reqs: [1, 2, 3].map((n) => req({ url: `https://a/${n}` })) });

    // `JSON.stringify(Infinity)` 是 `null`：不夹的话 `slice(len - null)` 会回 `items: []`
    // 而 matched 仍报 3 —— 本批最恨的「空 ≠ 没有」，且发生在最要紧的一处。
    for (const limit of [Infinity, NaN]) {
      expect(readEnvelope({ kind: "reqs", limit }, win).items, String(limit)).toHaveLength(3);
    }

    const negative = readEnvelope({ kind: "reqs", limit: -1 }, win);
    expect(negative.items).toHaveLength(0);
    expect(negative.matched).toBe(3); // 空是**请求**空，不是"没有"
  });

  it("armedBefore：早就装上 = true；这次才装上 = false（且探针确实装上了）", () => {
    expect(readEnvelope({ kind: "reqs", limit: 5 }, armedWindow({})).armedBefore).toBe(true);

    const { win } = makeWindow();
    const v = readEnvelope({ kind: "reqs", limit: 5 }, win);

    expect(v.ok).toBe(true);
    expect(v.armedBefore).toBe(false); // 这份文档是**这次**才装上的：之前的请求看不到
    expect(win.__aideRec).toBeTruthy();
  });
});

// ---- 注册编排：每个视图只注册一次（缺省 view_id 也不重发） ----

/** 等到第 n 条桥请求出现——调用是串行的，结算完上一条才会发下一条。 */
async function waitForQuery(events: ChatEvent[], n: number): Promise<any> {
  for (let i = 0; i < 200 && events.length <= n; i++) await new Promise((r) => setTimeout(r, 0));
  const q = events[n];
  if (!q) throw new Error(`bridge query #${n} never arrived (got ${events.length})`);
  return q as any;
}

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

function reply(q: any, body: { ok: boolean; data?: unknown; error?: string }): void {
  resolveBrowserResult({ request_id: q.request_id, ...body });
}

/** 一份成功的求值回包（CDP 形状），信封里只有 `armedBefore` 是用例关心的。 */
function envelope(armedBefore: boolean) {
  return {
    view_id: "browser-1",
    value: {
      result: {
        type: "object",
        value: {
          ok: true,
          armedBefore,
          cap: RECORDER_CAP,
          total: 0,
          matched: 0,
          failed: { n: 0, first: null },
          items: [],
        },
      },
    },
  };
}

describe("recorder：注册按视图只发一次", () => {
  it("第一次发注册；第二次复用记账不发；读到没装上的文档后，第三次真的重注册", async () => {
    const { events, emit } = emitCollector();

    // 1) 缺省 view_id（文档化的正常调用方式）：先注册，再求值
    const first = readRecorder({ kind: "reqs", limit: 5 }, undefined, emit);
    const reg1 = await waitForQuery(events, 0);
    // 注入走宿主 API 那条 op（**不是** CDP 的 Page.addScriptToEvaluateOnNewDocument——
    // 那条在本机 WebView2 上被接受但不交货，见 Task 13 的真机取证）。
    expect(reg1.op).toBe("init_script");
    expect(reg1.script).toBe(RECORDER_SOURCE);
    expect(reg1.view_id).toBeUndefined();
    reply(reg1, { ok: true, data: { view_id: "browser-1", registered: true } });
    reply(await waitForQuery(events, 1), { ok: true, data: envelope(false) });
    await first;

    // 2) 第二次：命中记账 ⇒ **第 2 条请求直接是求值**（中间没有注册）。
    //    但这份文档没在创建时装上（视图被换掉了）⇒ 缓存作废，只是本次不重发。
    const second = readRecorder({ kind: "reqs", limit: 5 }, undefined, emit);
    const eval2 = await waitForQuery(events, 2);
    expect(eval2.method).toBe("Runtime.evaluate");
    reply(eval2, { ok: true, data: envelope(false) });
    await second;

    // 3) 第三次：缓存已丢 ⇒ 真的重注册（这次 Rust 解析回来的是新视图）
    const third = readRecorder({ kind: "reqs", limit: 5 }, undefined, emit);
    const reg3 = await waitForQuery(events, 3);
    expect(reg3.op).toBe("init_script");
    reply(reg3, { ok: true, data: { view_id: "browser-2", registered: true } });
    reply(await waitForQuery(events, 4), { ok: true, data: envelope(false) });
    await third;
  });

  /** 注入失败**不许**被记成"注册过了"：记了账下一次就再不发，未来文档永久漏装（静默劣化）。 */
  it("注册失败 → 如实带 registerError，且不记账（下次真的重发）", async () => {
    const { events, emit } = emitCollector();

    const first = readRecorder({ kind: "reqs", limit: 5 }, "browser-fail", emit);
    const reg1 = await waitForQuery(events, 0);
    expect(reg1.op).toBe("init_script");
    reply(reg1, { ok: false, error: "cannot register an init script for view browser-fail: boom" });
    reply(await waitForQuery(events, 1), { ok: true, data: envelope(true) });
    const outcome = await first;

    // 注入失败**不阻断**本次读（当前文档那份靠读脚本里的内联装上），但要如实说未来没覆盖。
    expect(outcome).toMatchObject({ ok: true, registered: false });
    expect(String((outcome as { registerError?: string }).registerError)).toContain("boom");

    const second = readRecorder({ kind: "reqs", limit: 5 }, "browser-fail", emit);
    const reg2 = await waitForQuery(events, 2);
    expect(reg2.op).toBe("init_script"); // 失败没进记账 ⇒ 再发一次
    reply(reg2, { ok: true, data: { view_id: "browser-fail", registered: true } });
    reply(await waitForQuery(events, 3), { ok: true, data: envelope(true) });
    await second;
  });

  it("显式 view_id 也只注册一次（永久记账，不受缓存自愈影响）", async () => {
    const { events, emit } = emitCollector();

    const first = readRecorder({ kind: "reqs", limit: 5 }, "browser-9", emit);
    reply(await waitForQuery(events, 0), {
      ok: true,
      data: { view_id: "browser-9", registered: true },
    });
    reply(await waitForQuery(events, 1), { ok: true, data: envelope(false) });
    await first;

    const second = readRecorder({ kind: "reqs", limit: 5 }, "browser-9", emit);
    const eval2 = await waitForQuery(events, 2);
    expect(eval2.method).toBe("Runtime.evaluate");
    reply(eval2, { ok: true, data: envelope(false) });
    await second;
  });
});
