import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../api", () => ({
  api: {
    lspDefinition: vi.fn(),
  },
}));

import { resolve, prefetch, peek, keyOf, invalidateFile, __resetForTest } from "./index";
import { api } from "../../api";
import type { LspJumpResult, QueryResult } from "../../types";

const WS = "/p";
const FILE = "/p/main.rs";
const LINE = 1;
const COL = 3;
const WORD = "foo";

function ok(results: QueryResult[]): LspJumpResult {
  return { status: "ok", results };
}
function mk(file: string, line: number): QueryResult {
  return { symbol: { name: "foo", kind: "Function", file, line, column: 0, parent: null }, confidence: "Structure", score: null };
}
/** 刷完所有挂起微任务（macrotask 边界后），用于 settle prefetch 的 fire-and-forget 链。 */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe("definitionResolver/index", () => {
  beforeEach(() => {
    __resetForTest();
    vi.clearAllMocks();
  });

  it("resolve_caches_ok_nonempty_then_hit_zero_extra_api", async () => {
    (api.lspDefinition as any).mockResolvedValue(ok([mk("/p/def.rs", 9)]));
    await resolve(WS, FILE, LINE, COL, WORD);
    expect(api.lspDefinition).toHaveBeenCalledTimes(1);
    expect(peek(WS, FILE, LINE, COL, WORD)).not.toBeNull();
    // 缓存命中 → 合成 ok，不再调 api
    const j = await resolve(WS, FILE, LINE, COL, WORD);
    expect(j.status).toBe("ok");
    expect(j.results.length).toBe(1);
    expect(api.lspDefinition).toHaveBeenCalledTimes(1);
  });

  it("never_caches_ok_empty", async () => {
    (api.lspDefinition as any).mockResolvedValue(ok([]));
    await resolve(WS, FILE, LINE, COL, WORD);
    expect(peek(WS, FILE, LINE, COL, WORD)).toBeNull();
  });

  it("never_caches_timeout", async () => {
    (api.lspDefinition as any).mockResolvedValue({ status: "timeout", results: [] });
    await resolve(WS, FILE, LINE, COL, WORD);
    expect(peek(WS, FILE, LINE, COL, WORD)).toBeNull();
  });

  it("never_caches_not_ready", async () => {
    (api.lspDefinition as any).mockResolvedValue({ status: "not_ready", results: [] });
    await resolve(WS, FILE, LINE, COL, WORD);
    expect(peek(WS, FILE, LINE, COL, WORD)).toBeNull();
  });

  it("never_caches_gone", async () => {
    (api.lspDefinition as any).mockResolvedValue({ status: "gone", results: [] });
    await resolve(WS, FILE, LINE, COL, WORD);
    expect(peek(WS, FILE, LINE, COL, WORD)).toBeNull();
  });

  it("dedup_two_concurrent_resolve_one_api_same_promise", async () => {
    let release: (v: any) => void = () => {};
    (api.lspDefinition as any).mockImplementation(() => new Promise<any>(r => { release = r; }));
    const p1 = resolve(WS, FILE, LINE, COL, WORD);
    const p2 = resolve(WS, FILE, LINE, COL, WORD);
    expect(p1).toBe(p2); // 同 in-flight promise
    expect(api.lspDefinition).toHaveBeenCalledTimes(1);
    release(ok([mk("/p/def.rs", 9)]));
    await p1;
    expect(peek(WS, FILE, LINE, COL, WORD)).not.toBeNull(); // settle 后缓存
  });

  it("settle_guard_invalidate_midflight_skips_cache_write", async () => {
    let release: (v: any) => void = () => {};
    (api.lspDefinition as any).mockImplementation(() => new Promise<any>(r => { release = r; }));
    const p = resolve(WS, FILE, LINE, COL, WORD);
    invalidateFile(FILE); // 在途期间失效 → epoch++
    release(ok([mk("/p/def.rs", 9)]));
    await p;
    expect(peek(WS, FILE, LINE, COL, WORD)).toBeNull(); // epoch 不等 → 未写缓存
  });

  it("prefetch_respects_cache", async () => {
    (api.lspDefinition as any).mockResolvedValue(ok([mk("/p/def.rs", 9)]));
    prefetch(WS, FILE, LINE, COL, WORD);
    await flush();
    expect(api.lspDefinition).toHaveBeenCalledTimes(1);
    expect(peek(WS, FILE, LINE, COL, WORD)).not.toBeNull();
    prefetch(WS, FILE, LINE, COL, WORD); // 已缓存 → 跳过
    await flush();
    expect(api.lspDefinition).toHaveBeenCalledTimes(1);
  });

  it("prefetch_respects_inflight", () => {
    let release: (v: any) => void = () => {};
    (api.lspDefinition as any).mockImplementation(() => new Promise<any>(r => { release = r; }));
    prefetch(WS, FILE, LINE, COL, WORD); // 启动 in-flight
    prefetch(WS, FILE, LINE, COL, WORD); // 已 in-flight → 跳过
    expect(api.lspDefinition).toHaveBeenCalledTimes(1);
    release(ok([mk("/p/def.rs", 9)])); // 清理（避免悬挂）
  });

  it("prefetch_cap_skips_beyond_8", () => {
    (api.lspDefinition as any).mockImplementation(() => new Promise<any>(() => {})); // 永不 resolve，占住 in-flight
    for (let i = 0; i < 8; i++) prefetch(WS, FILE, LINE, i + 1, `w${i}`); // 8 个不同键
    expect(api.lspDefinition).toHaveBeenCalledTimes(8);
    prefetch(WS, FILE, LINE, 100, "w9"); // cap → 跳过
    expect(api.lspDefinition).toHaveBeenCalledTimes(8);
  });

  it("prefetch_failure_silent_no_throw", async () => {
    (api.lspDefinition as any).mockRejectedValue(new Error("boom"));
    prefetch(WS, FILE, LINE, COL, WORD); // fire-and-forget 吞错
    await flush();
    expect(peek(WS, FILE, LINE, COL, WORD)).toBeNull();
  });

  it("keyof_normalizes_backslashes", () => {
    const k1 = keyOf("C:\\p", "C:\\p\\a.rs", 1, 3, "foo");
    const k2 = keyOf("C:/p", "C:/p/a.rs", 1, 3, "foo");
    expect(k1).toBe(k2);
  });

  it("keyof_wordstart_col_sensitive", () => {
    // 同 line+word 不同词首列 → 不同键
    const k1 = keyOf(WS, FILE, LINE, 3, WORD);
    const k2 = keyOf(WS, FILE, LINE, 7, WORD);
    expect(k1).not.toBe(k2);
  });
});