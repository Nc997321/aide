import { describe, it, expect, afterEach } from "vitest";
import type { ChatEvent } from "../../engine/types.js";
import { runEval } from "./runEval.js";
import { cancelAllBrowserQueries, resolveBrowserResult } from "../browserClient.js";

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

/** 等到第 n 条桥请求出现——调用是串行的，结算完上一条才会发下一条。 */
async function waitForQuery(events: ChatEvent[], n: number): Promise<any> {
  for (let i = 0; i < 200 && events.length <= n; i++) await new Promise((r) => setTimeout(r, 0));
  const q = events[n];
  if (!q) throw new Error(`bridge query #${n} never arrived (got ${events.length})`);
  return q as any;
}

/** 一次成功的 CDP 求值回包（`{view_id, value}`，value 即 CDP 响应体）。 */
function cdpOk(requestId: string, result: unknown): void {
  resolveBrowserResult({ request_id: requestId, ok: true, data: { view_id: "browser-1", value: result } });
}

/**
 * 求值成功 = **一发往返**（可见性探测已随 parking 删除——不显示的视图照样合成）。
 * 这个 helper 把那一发答掉，省得每条用例手写。
 */
async function answerEval(events: ChatEvent[], index: number, cdpBody: unknown): Promise<void> {
  cdpOk((events[index] as any).request_id, cdpBody);
}

afterEach(() => cancelAllBrowserQueries("test cleanup"));

describe("runEval 主路径（CDP）", () => {
  /**
   * **不许加包装器**（踩过两次：多语句被弄坏、语法错误检测兜不住）。脚本必须原样送进去——
   * 裸通道回的是脚本的**完成值**，`var x = 1; x + 2` 回 `3`（本机实测），包装就没了。
   */
  it("请求带 awaitPromise + returnByValue，且 expression 是**原脚本**（没有任何包装）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("1 + 1", {}, emit);

    const q = events[0] as any;
    expect(q.op).toBe("call_cdp");
    expect(q.method).toBe("Runtime.evaluate");
    expect(q.params.awaitPromise).toBe(true);
    expect(q.params.returnByValue).toBe(true);
    expect(q.params.expression).toBe("1 + 1");

    await answerEval(events, 0, { result: { type: "number", value: 2 } });
    const r = await p;

    expect(r).toEqual({
      ok: true,
      via: "cdp",
      value: 2,
      viewId: "browser-1",
      probe: { pending: false },
    });
  });

  it("async 表达式原样送——解 Promise 是 awaitPromise 的活，不是包装器的", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("(async () => 42)()", {}, emit);

    expect((events[0] as any).params.expression).toBe("(async () => 42)()");
    await answerEval(events, 0, { result: { type: "number", value: 42 } });

    expect((await p) as any).toMatchObject({ ok: true, value: 42 });
  });

  it("多语句脚本原样送（这是包装器曾经弄坏的那个用法）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("var x = 1; x + 2", {}, emit);

    expect((events[0] as any).params.expression).toBe("var x = 1; x + 2");
    await answerEval(events, 0, { result: { type: "number", value: 3 } });

    expect((await p) as any).toMatchObject({ ok: true, value: 3 });
  });

  it("undefined 是**合法结果**，不是失败（CDP 不给 value 字段）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("void 0", {}, emit);

    await answerEval(events, 0, { result: { type: "undefined" } });
    expect(await p).toEqual({
      ok: true,
      via: "cdp",
      value: undefined,
      viewId: "browser-1",
      probe: { pending: false },
    });
  });

  it("传不回来的类型（function/symbol）如实说不可序列化，不伪装成 null", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("() => {}", {}, emit);
    cdpOk((events[0] as any).request_id, { result: { type: "function", description: "() => {}" } });

    const r = await p;
    expect(r.ok).toBe(false);
    expect((r as any).kind).toBe("unserializable");
    expect((r as any).error).toContain("() => {}");
  });

  it("每次求值**只发一发**：可见性探测已随 parking 删除（以前每跳多一次往返）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("1", {}, emit);

    cdpOk((events[0] as any).request_id, { result: { type: "number", value: 1 } });
    const r = await p;

    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1); // 没有第二发（旧实现会再问一次 document.visibilityState）
    expect((r as any).probe).toEqual({ pending: false });
  });
});

describe("runEval 失败判据", () => {
  it("exceptionDetails → kind=exception，且**不降级**（降级会重跑脚本的副作用）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("nope()", {}, emit);
    cdpOk((events[0] as any).request_id, {
      result: { type: "object" },
      exceptionDetails: {
        // 同步抛出时 CDP 的真实形状：`text` 只有 "Uncaught"，原因在 exception.description
        text: "Uncaught",
        exception: {
          type: "object",
          subtype: "error",
          className: "ReferenceError",
          description: "ReferenceError: nope is not defined\n    at <anonymous>:1:1",
        },
      },
    });

    const r = await p;
    expect(r.ok).toBe(false);
    expect((r as any).kind).toBe("exception");
    // 拿到的必须是**原因**，不是那个光秃秃的 "Uncaught"
    expect((r as any).error).toContain("nope is not defined");
    expect((r as any).error).not.toContain("at <anonymous>"); // 栈是噪音，只留第一行
    // 只发了一次：失败路径不做可见性探测，也不重跑
    expect(events).toHaveLength(1);
  });

  it("非 Error 对象（`throw \"boom\"`）→ 退回 text（description 拿不到时就只有它）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval('throw "boom"', {}, emit);
    cdpOk((events[0] as any).request_id, {
      result: { type: "object" },
      exceptionDetails: { text: "Uncaught", exception: { type: "string", value: "boom" } },
    });

    expect((await p) as any).toMatchObject({ ok: false, kind: "exception" });
  });

  it("CDP 方法级 error（回包是 {error}）→ 降级到 ExecuteScript，且改用同步包装", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("1 + 1", {}, emit);

    cdpOk((events[0] as any).request_id, { error: { code: -32601, message: "'Runtime.evaluate' wasn't found" } });

    const q1 = await waitForQuery(events, 1);
    expect(q1.op).toBe("eval");
    // 同步包装：能带出 pending / thrown，比裸 ExecuteScript 的「抛异常回 null」强
    expect(q1.script).toContain("pending");
    expect(q1.script).toContain("thrown");
    expect(q1.script).toContain("1 + 1");

    resolveBrowserResult({
      request_id: q1.request_id,
      ok: true,
      data: { view_id: "browser-1", value: { value: 2, pending: false } },
    });
    const r = await p;
    expect(r).toEqual({
      ok: true,
      via: "executescript",
      value: 2,
      viewId: "browser-1",
      probe: { pending: false },
    });
  });

  it("降级路径上脚本抛异常也能带出原因（同步包装的 try/catch 兜住了它）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("nope()", {}, emit);
    cdpOk((events[0] as any).request_id, { error: { code: -32601, message: "unavailable" } });

    const q1 = await waitForQuery(events, 1);
    resolveBrowserResult({
      request_id: q1.request_id,
      ok: true,
      data: { value: { thrown: "nope is not defined" } },
    });
    const r = await p;

    expect(r.ok).toBe(false);
    expect((r as any).kind).toBe("exception");
    expect((r as any).error).toContain("nope is not defined");
  });

  it("降级路径上 async 脚本 await 不了 → 如实带 pending，不假装成功", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("(async () => 42)()", {}, emit);
    cdpOk((events[0] as any).request_id, { error: { code: -32601, message: "unavailable" } });

    const q1 = await waitForQuery(events, 1);
    resolveBrowserResult({
      request_id: q1.request_id,
      ok: true,
      data: { value: { value: null, pending: true } },
    });
    expect((await p) as any).toMatchObject({ ok: true, probe: { pending: true } });
  });

  /**
   * 降级通道上包装器包不了多语句（它只接受表达式）——拿到 `null` 就说明整段没解析成功。
   * 裸通道本来支持多语句，所以**脱壳再送一次**。解析期失败 ⇒ 没执行过，重试无副作用。
   */
  it("降级路径上多语句脚本 → 脱壳重送，拿回完成值", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("var x = 1; x + 2", {}, emit);
    cdpOk((events[0] as any).request_id, { error: { code: -32601, message: "unavailable" } });

    resolveBrowserResult({
      request_id: (await waitForQuery(events, 1)).request_id,
      ok: true,
      data: { value: null }, // 包装器解析失败
    });

    const bare = await waitForQuery(events, 2);
    expect(bare.op).toBe("eval");
    expect(bare.script).toBe("var x = 1; x + 2"); // 原脚本，没有包装
    resolveBrowserResult({ request_id: bare.request_id, ok: true, data: { value: 3 } });

    expect((await p) as any).toMatchObject({ ok: true, value: 3, via: "executescript" });
  });

  it("桥层失败 → kind=bridge，不降级（对面没回包，换条路也一样没回）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("1", {}, emit);
    resolveBrowserResult({
      request_id: (events[0] as any).request_id,
      ok: false,
      error: "view browser-9 does not exist",
    });

    const r = await p;
    expect(r.ok).toBe(false);
    expect((r as any).kind).toBe("bridge");
    expect((r as any).error).toContain("does not exist");
    expect(events).toHaveLength(1);
  });
});

describe("runEval 的上下文与透传", () => {
  it("contextId 与 view_id 原样进请求（帧级读取用）", async () => {
    const { events, emit } = emitCollector();
    const p = runEval("document.title", { viewId: "browser-3", contextId: 77 }, emit);
    const q = events[0] as any;

    expect(q.view_id).toBe("browser-3");
    expect(q.params.contextId).toBe(77);

    await answerEval(events, 0, { result: { type: "string", value: "T" } });
    await p;
  });
});
