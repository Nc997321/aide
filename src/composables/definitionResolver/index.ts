import { api } from "../../api";
import type { LspJumpResult, QueryResult } from "../../types";
import { cacheGet, cacheHas, cacheSet, currentEpoch, __resetCacheForTest } from "./cache";

export { invalidateFile, invalidateAll } from "./cache";

/** 跳转定义解析层：缓存（正向结果）+ hover 预取 + in-flight 去重 + epoch 失效。
 *
 *  这是「点击就跳转」体验的核心：hover 300ms 停留即预取（`prefetch`），点击时
 *  `peek` 同步命中缓存 → 真瞬时（无「跳转中…」）；hover 预取已在途则点击
 *  `resolve` await 同一 in-flight promise → 近瞬时；冷首跳单次解析后缓存，
 *  重复点击免费。上层 `useGotoDefinition.ts` 退化为消费方（peek 快路径 + resolve
 *  替原 retry 块），不在其上缝补。
 *
 *  缓存只存 `ok`+非空（cache.ts 约束）；键用词首列（`wordAt(pos).from` 对同词
 *  任意像素相同 → hover 与 click 同键 → 预取真正暖到点击）。 */

/** 预取并发上限：鼠标扫过悬停多个词时防爆 jdtls stdio 管道。仅约束 `prefetch`；
 *  `resolve`（click 权威路径）永不被此拦。 */
const MAX_INFLIGHT = 8;
const inflight = new Map<string, Promise<LspJumpResult>>();

/** 缓存键：`workspace|file|line|wordStartCol|word`，路径/根正斜杠归一。
 *  `wordStartCol` = `wordAt(pos).from - line.from + 1`（词首列，1-based）——对同一词
 *  内任意像素相同，故 hover 预取与 click 对同一词产出同键；且消解 `x.foo()`/`y.foo()`
 *  同行同词不同定义的碰撞（不同词首列 → 不同键 → 不错跳）。 */
export function keyOf(workspaceRoot: string, filePath: string, line: number, col: number, word: string): string {
  const ws = workspaceRoot.replace(/\\/g, "/");
  const f = filePath.replace(/\\/g, "/");
  return `${ws}|${f}|${line}|${col}|${word}`;
}

/** 同步查缓存（纯缓存，不查 in-flight——in-flight 是 promise，同步拿不到）。
 *  命中即瞬时跳转，无「跳转中…」。返回 RAW 结果（未打 `source` 标、含自引用），
 *  消费方负责 `stampLsp` 过滤+打标。 */
export function peek(workspaceRoot: string, filePath: string, line: number, col: number, word: string): QueryResult[] | null {
  const key = keyOf(workspaceRoot, filePath, line, col, word);
  const hit = cacheGet(key);
  return hit ?? null;
}

/** 权威解析：缓存命中→合成 `ok`；in-flight→await 同一 promise；否则发 `api.lspDefinition`。
 *  settle 时 epoch 比对 + 仅缓存 `ok`+非空；`finally` 删 in-flight。click 走此路，
 *  hover 预取也走此路（同键返同一 promise → 去重）。 */
export function resolve(workspaceRoot: string, filePath: string, line: number, col: number, word: string): Promise<LspJumpResult> {
  const key = keyOf(workspaceRoot, filePath, line, col, word);
  const cached = cacheGet(key);
  if (cached) { return Promise.resolve({ status: "ok", results: cached }); }
  const existing = inflight.get(key);
  if (existing) { return existing; }
  const myEpoch = currentEpoch();
  const p = api.lspDefinition(workspaceRoot, filePath, line, col, word)
    .then((jump: LspJumpResult) => {
      // epoch 不等 = 期间发生失效（docChanged/destroy）→ 跳过缓存写，但仍返结果。
      // 绝不缓存空 / timeout / not_ready / gone（cache.ts 约束）。
      const now = currentEpoch();
      const epochOk = now === myEpoch;
      const willWrite = epochOk && jump.status === "ok" && jump.results.length > 0;
      if (willWrite) cacheSet(key, jump.results);
      return jump;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** hover 停留预取：fire-and-forget。命中缓存/in-flight 或超并发上限则跳过。
 *  失败静默吞（预取无副作用，不向 UI 报错）。 */
export function prefetch(workspaceRoot: string, filePath: string, line: number, col: number, word: string): void {
  const key = keyOf(workspaceRoot, filePath, line, col, word);
  if (cacheHas(key) || inflight.has(key)) {
    console.warn(`[hover] prefetch skip cache=${cacheHas(key)} inflight=${inflight.has(key)} key=${key}`);
    return;
  }
  if (inflight.size >= MAX_INFLIGHT) { console.warn(`[hover] prefetch SKIP-CAP key=${key}`); return; }
  console.warn(`[hover] prefetch START key=${key}`);
  void resolve(workspaceRoot, filePath, line, col, word).catch(() => {
    /* 预取失败静默：消费方走自己的错误路径 */
  });
}

/** 测试专用：复位缓存 + in-flight + epoch。生产代码勿调。 */
export function __resetForTest(): void {
  __resetCacheForTest();
  inflight.clear();
}