import { describe, it, expect, beforeEach } from "vitest";
import {
  cacheSet,
  cacheGet,
  cacheHas,
  cacheCount,
  cacheDel,
  invalidateFile,
  invalidateAll,
  currentEpoch,
  __resetCacheForTest,
} from "./cache";
import type { QueryResult } from "../../types";

function mk(file: string, line: number): QueryResult {
  return { symbol: { name: "foo", kind: "Function", file, line, column: 0, parent: null }, confidence: "Structure", score: null };
}

describe("definitionResolver/cache", () => {
  beforeEach(() => __resetCacheForTest());

  it("set_get_has_del_count", () => {
    const r = [mk("/p/a.rs", 9)];
    cacheSet("k1", r);
    expect(cacheHas("k1")).toBe(true);
    expect(cacheGet("k1")).toBe(r);
    expect(cacheCount()).toBe(1);
    cacheDel("k1");
    expect(cacheHas("k1")).toBe(false);
    expect(cacheGet("k1")).toBeUndefined();
    expect(cacheCount()).toBe(0);
  });

  it("lru_evicts_oldest_at_cap_200", () => {
    for (let i = 0; i < 201; i++) cacheSet(`k${i}`, [mk("/p/a.rs", i)]);
    expect(cacheCount()).toBe(200);
    expect(cacheHas("k0")).toBe(false); // 最老的被驱逐
    expect(cacheHas("k200")).toBe(true);
    expect(cacheHas("k199")).toBe(true);
  });

  it("invalidate_file_removes_only_that_file_keys_and_bumps_epoch", () => {
    const e0 = currentEpoch();
    cacheSet("/p|/p/a.rs|1|3|foo", [mk("/p/def.rs", 9)]);
    cacheSet("/p|/p/b.rs|1|3|foo", [mk("/p/def.rs", 9)]);
    invalidateFile("/p/a.rs");
    expect(currentEpoch()).toBe(e0 + 1);
    expect(cacheHas("/p|/p/a.rs|1|3|foo")).toBe(false);
    expect(cacheHas("/p|/p/b.rs|1|3|foo")).toBe(true); // 不误删
  });

  it("invalidate_file_normalizes_backslash_input_to_match_fwdslash_key", () => {
    cacheSet("C:/p|C:/p/a.rs|1|3|foo", [mk("/p/def.rs", 9)]);
    invalidateFile("C:\\p\\a.rs"); // 反斜杠入参，内部归一后匹配正斜杠键
    expect(cacheHas("C:/p|C:/p/a.rs|1|3|foo")).toBe(false);
  });

  it("invalidate_file_segment_boundary_no_false_match", () => {
    // /p/a.rs 不应误匹配 /p/a.rs.bak 的键（前导 | 段边界）
    cacheSet("/p|/p/a.rs.bak|1|3|foo", [mk("/p/def.rs", 9)]);
    invalidateFile("/p/a.rs");
    expect(cacheHas("/p|/p/a.rs.bak|1|3|foo")).toBe(true); // 不误删
  });

  it("invalidate_all_clears_and_bumps_epoch", () => {
    const e0 = currentEpoch();
    cacheSet("k1", [mk("/p/a.rs", 1)]);
    cacheSet("k2", [mk("/p/b.rs", 1)]);
    invalidateAll();
    expect(currentEpoch()).toBe(e0 + 1);
    expect(cacheCount()).toBe(0);
  });
});