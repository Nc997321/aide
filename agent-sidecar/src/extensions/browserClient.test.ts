import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatEvent } from "../engine/types.js";
import {
  queryBrowser,
  resolveBrowserResult,
  cancelAllBrowserQueries,
  BROWSER_QUERY_TIMEOUT_MS,
} from "./browserClient.js";

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

afterEach(() => {
  vi.useRealTimers();
  cancelAllBrowserQueries("test cleanup");
});

describe("browserClient", () => {
  it("emits browser_query with the op payload and resolves on matching result", async () => {
    const { events, emit } = emitCollector();
    const p = queryBrowser({ op: "eval", view_id: "browser-1", script: "1+1" }, emit);

    expect(events).toHaveLength(1);
    const q = events[0] as any;
    expect(q.type).toBe("browser_query");
    expect(q.op).toBe("eval");
    expect(q.view_id).toBe("browser-1");
    expect(q.script).toBe("1+1");
    expect(typeof q.request_id).toBe("string");
    // 桥协议里不该出现别的桥的字段（几座桥共用 reader 拦截链，串了就是静默错投）。
    expect(q.project_root).toBeUndefined();

    resolveBrowserResult({ request_id: q.request_id, ok: true, data: { value: 2 } });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ value: 2 });
  });

  it("list_views carries no extra payload keys", async () => {
    const { events, emit } = emitCollector();
    const p = queryBrowser({ op: "list_views" }, emit);
    const q = events[0] as any;
    expect(q.op).toBe("list_views");
    expect(q.script).toBeUndefined();
    expect(q.method).toBeUndefined();
    resolveBrowserResult({ request_id: q.request_id, ok: true, data: { views: [] } });
    expect((await p).ok).toBe(true);
  });

  it("surfaces the Rust error text on ok:false", async () => {
    const { events, emit } = emitCollector();
    const p = queryBrowser({ op: "list_views" }, emit);
    const q = events[0] as any;
    resolveBrowserResult({ request_id: q.request_id, ok: false, error: "no embedded browser view is open" });
    const r = await p;
    expect(r.ok).toBe(false);
    // 错误文本必须原样透出——Rust 侧把它写成面向模型的说明，加工就是丢信息。
    expect(r.error).toContain("no embedded browser view is open");
  });

  it("times out and says the host did not reply", async () => {
    vi.useFakeTimers();
    const { emit } = emitCollector();
    const p = queryBrowser({ op: "list_views" }, emit);
    await vi.advanceTimersByTimeAsync(BROWSER_QUERY_TIMEOUT_MS + 1);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  /**
   * 超时层级是**契约**不是巧合：客户端必须比 Rust adapter 的 NATIVE_TIMEOUT(10s) 长，
   * 否则「视图不存在」「脚本报错」这类快错误会被这里笼统兜底成 timed out，
   * 模型会以为浏览器卡了，实际是脚本写错了。
   */
  it("client timeout outlives the Rust adapter timeout (10s)", () => {
    expect(BROWSER_QUERY_TIMEOUT_MS).toBeGreaterThan(10_000);
  });

  it("ignores results for unknown request_id", () => {
    expect(() => resolveBrowserResult({ request_id: "nope", ok: true })).not.toThrow();
  });

  it("cancelAll resolves every pending query as cancelled", async () => {
    const { emit } = emitCollector();
    const p1 = queryBrowser({ op: "list_views" }, emit);
    const p2 = queryBrowser({ op: "eval", script: "x" }, emit);
    cancelAllBrowserQueries("session stopped");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cancelled).toBe(true);
    expect(r1.error).toContain("session stopped");
    expect(r2.cancelled).toBe(true);
  });

  it("late result after timeout is dropped silently", async () => {
    vi.useFakeTimers();
    const { events, emit } = emitCollector();
    const p = queryBrowser({ op: "list_views" }, emit);
    await vi.advanceTimersByTimeAsync(BROWSER_QUERY_TIMEOUT_MS + 1);
    await p;
    const q = events[0] as any;
    expect(() => resolveBrowserResult({ request_id: q.request_id, ok: true })).not.toThrow();
  });
});
