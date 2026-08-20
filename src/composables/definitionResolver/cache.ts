import type { QueryResult } from "../../types";

/** 跳转定义结果缓存——只存 LSP 确认的正向结果（`ok`+非空），绝不缓存空 /
 *  `timeout` / `not_ready` / `gone`。空 = jdtls 渐进解析期「暂时没找到」，钉死成
 *  「永远没找到」是 bug；沿用 `cmImplGutter.ts:160` 的「不缓存冷 server 空结果」
 *  规约（空 = 未知，可重试）。键由 `index.ts::keyOf` 生成
 *  （`workspace|file|line|wordStartCol|word`，正斜杠归一）。
 *
 *  失效用单全局 `epoch` 计数器（非 per-file map——避开 undefined-vs-0 与跨文件
 *  误失效）：`invalidateFile`/`invalidateAll` 自增 epoch；`index.ts::resolve` 在
 *  发请求前捕获 `myEpoch`，settle 时不等则**跳过缓存写入**（但仍 resolve promise，
 *  消费方照常显示，等同无缓存行为；click await 一个被失效的 in-flight 拿到的仍是
 *  合法结果，非新失败模式）。
 *
 *  本模块无 Vue / api 依赖——纯数据结构，便于单测。 */
const CACHE_MAX = 200;
const cache = new Map<string, QueryResult[]>();
let epoch = 0;

export function cacheGet(key: string): QueryResult[] | undefined {
  return cache.get(key);
}

export function cacheHas(key: string): boolean {
  return cache.has(key);
}

export function cacheCount(): number {
  return cache.size;
}

export function cacheSet(key: string, value: QueryResult[]): void {
  if (cache.size >= CACHE_MAX) {
    // Map 按插入序迭代，删最老的一条即最简 LRU——够用，无需引依赖（同 markdown.ts:65-79）
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

export function cacheDel(key: string): void {
  cache.delete(key);
}

/** 失效某文件所有键（`docChanged`/`destroy` 触发）。epoch 自增让在途请求 settle 时
 *  跳过缓存写。键形如 `${ws}|${file}|${line}|...`，file 段已正斜杠归一——以
 *  `|${norm}|` 作段边界匹配，前导 `|` 防 `/p/a.rs` 误匹配 `/p/a.rs.bak` 的键。 */
export function invalidateFile(absFile: string): void {
  epoch++;
  const norm = absFile.replace(/\\/g, "/");
  const seg = `|${norm}|`;
  for (const key of cache.keys()) {
    if (key.includes(seg)) cache.delete(key);
  }
}

/** 全清（测试 / 罕见全局失效）。在途 promise 自然 settle（epoch guard 跳过写入）。 */
export function invalidateAll(): void {
  epoch++;
  cache.clear();
}

/** 在途请求捕获的 epoch 比对入口。 */
export function currentEpoch(): number {
  return epoch;
}

/** 测试专用：复位缓存与 epoch（in-flight 由 `index.ts::__resetForTest` 清）。
 *  生产代码勿调。 */
export function __resetCacheForTest(): void {
  cache.clear();
  epoch = 0;
}