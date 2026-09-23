// @vitest-environment node
//
// recorder 是**注入进页面的源码字符串**，vitest 没有 DOM —— 这里用最小桩把源码跑起来，
// 断言的是 recorder 自己的契约（幂等 / 不改页面行为 / 有界 / 如实标截断），
// 真实页面上的行为由真机夹具（docs/testing/browser-recorder-fixture.html）验。
//
// ⚠️ 桩 console 必须传进去：源码里是裸 `console[lvl] = …`，不 shadow 就会改到 vitest 自己的 console。
import { describe, it, expect } from "vitest";
import { RECORDER_SOURCE, RECORDER_CAP, RECORDER_TEXT_CAP } from "./recorder.js";

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

function fetchStub(opts: { status?: number; body?: string; len?: string | null; reject?: string }) {
  return () => {
    if (opts.reject) return Promise.reject(new Error(opts.reject));
    const res = {
      status: opts.status ?? 200,
      headers: { get: (h: string) => (h === "content-length" ? (opts.len ?? null) : null) },
      clone: () => ({ text: () => Promise.resolve(opts.body ?? "") }),
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

  it("content-length 超闸门 → 不读体，如实标 skipped", async () => {
    const { win } = makeWindow({ fetch: fetchStub({ len: String(300 * 1024), body: "z" }) });
    run(RECORDER_SOURCE, win, { log: () => {} });
    await win.fetch("http://x/api");
    await flush();

    expect(win.__aideRec.reqs[0].body).toBeNull();
    expect(String(win.__aideRec.reqs[0].err)).toContain("body skipped");
    expect(win.__aideRec.reqs[0].done).toBe(true);
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
