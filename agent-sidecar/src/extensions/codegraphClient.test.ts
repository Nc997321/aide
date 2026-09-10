import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatEvent } from "../types.js";
import {
  queryCodegraph,
  resolveCodegraphResult,
  cancelAllCodegraphQueries,
  CODEGRAPH_QUERY_TIMEOUT_MS,
} from "./codegraphClient.js";

function emitCollector() {
  const events: ChatEvent[] = [];
  return { events, emit: (e: ChatEvent) => events.push(e) };
}

afterEach(() => {
  vi.useRealTimers();
  cancelAllCodegraphQueries("test cleanup");
});

describe("codegraphClient", () => {
  it("emits codegraph_query and resolves on matching result", async () => {
    const { events, emit } = emitCollector();
    const p = queryCodegraph("find_symbol", { name: "save" }, "/proj", emit);
    expect(events).toHaveLength(1);
    const q = events[0] as any;
    expect(q.type).toBe("codegraph_query");
    expect(q.tool).toBe("find_symbol");
    expect(q.args).toEqual({ name: "save" });
    expect(q.project_root).toBe("/proj");
    expect(typeof q.request_id).toBe("string");

    resolveCodegraphResult({
      request_id: q.request_id,
      ok: true,
      status: "ready",
      results: [{ file: "a.ts", line: 1 }],
    });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.status).toBe("ready");
    expect(r.results).toHaveLength(1);
  });

  it("times out after 10s and reports timedOut", async () => {
    vi.useFakeTimers();
    const { emit } = emitCollector();
    const p = queryCodegraph("find_symbol", { name: "x" }, "/proj", emit);
    await vi.advanceTimersByTimeAsync(CODEGRAPH_QUERY_TIMEOUT_MS + 1);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it("ignores results for unknown request_id", () => {
    expect(() =>
      resolveCodegraphResult({ request_id: "nope", ok: true }),
    ).not.toThrow();
  });

  it("cancelAll resolves every pending query as cancelled", async () => {
    const { emit } = emitCollector();
    const p1 = queryCodegraph("find_symbol", { name: "a" }, "/p", emit);
    const p2 = queryCodegraph("call_graph", { name: "b", direction: "callers" }, "/p", emit);
    cancelAllCodegraphQueries("session interrupted");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.cancelled).toBe(true);
    expect(r1.error).toContain("interrupted");
    expect(r2.cancelled).toBe(true);
  });

  it("late result after timeout is dropped silently", async () => {
    vi.useFakeTimers();
    const { events, emit } = emitCollector();
    const p = queryCodegraph("find_symbol", { name: "x" }, "/proj", emit);
    await vi.advanceTimersByTimeAsync(CODEGRAPH_QUERY_TIMEOUT_MS + 1);
    await p;
    const q = events[0] as any;
    expect(() =>
      resolveCodegraphResult({ request_id: q.request_id, ok: true, status: "ready" }),
    ).not.toThrow();
  });
});
