/**
 * `browser_read` 的 `since_last`：**只回上一次读之后变了的行**。
 *
 * 存在的理由（2026-10-07 agent 实测反馈）：「改页面 → 再读一遍核对」是高频闭环，而每次都把
 * 整页骨架（上百行表格、上百个按钮）重新喂进上下文，模型要自己逐行比对前后两份——又贵又容易看漏。
 *
 * # 比的是渲染后的文本，不是页面 JSON
 *
 * 渲染文本就是模型看到的东西，差异直接就是它能读的行；在页面侧比 JSON 要么得把上一份塞回页面，
 * 要么得在这里再写一份结构 diff。行级 LCS 在骨架规模（≲ 几千行）上是毫秒级。
 *
 * # 底稿
 *
 * 每次 `browser_read` 都把**全文版**渲染（`fullText`）记成底稿，与这次是否 `since_last` 无关——
 * 否则「先普通读、再 since_last」这个最自然的顺序会没有底稿。键带上 `include_hidden`：两种口径
 * 的骨架本来就不同，跨口径比只会报出一堆假变化。
 *
 * 底稿是**进程级、按视图**的：工具实例每轮 query 重建（闭包活不过一轮，而「这轮改、下轮核对」很常见），
 * sidecar 又是多会话同进程。视图本身就是跨会话共享的（`browser_tabs` 列的是同一批），所以文案
 * 照实说「这个视图上一次被读时」，不假装是"你上一次读"。条数有上限（关掉的视图不清账）。
 */

/** 去掉公共前后缀后，中间段 n·m 超过它就不做 LCS（表是 n·m 个 u32），直接如实说比不了。 */
const DIFF_MAX_CELLS = 4_000_000;
/** 差异行太多时只列这么多（其余报数）——差异比全文还长就失去了意义。 */
const DIFF_MAX_SHOWN = 300;

/** 行级差异：`-` 删 / `+` 增，保持出现顺序。超规模回 null。 */
export function diffLines(prev: string, next: string): { removed: number; added: number; lines: string[] } | null {
  const a = prev.split("\n");
  const b = next.split("\n");
  // 去掉公共前后缀，LCS 只算中间那段（典型的"改了一行"几乎零开销）
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);

  const n = x.length, m = y.length;
  if (n * m > DIFF_MAX_CELLS) return null;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let removed = 0, added = 0, i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { i++; j++; }
    else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) { lines.push(`+ ${y[j]}`); added++; j++; }
    else { lines.push(`- ${x[i]}`); removed++; i++; }
  }
  return { removed, added, lines };
}

/** 底稿条数上限（Map 的插入序 = 最旧先淘汰）。 */
const BASELINES_MAX = 32;

/** 底稿：按 `view|hidden` 记最近一次全文渲染。 */
export class ReadBaselines {
  private readonly map = new Map<string, string>();

  private static key(viewId: string, includeHidden: boolean): string {
    return `${viewId}|${includeHidden ? "hidden" : "rendered"}`;
  }

  get(viewId: string, includeHidden: boolean): string | undefined {
    return this.map.get(ReadBaselines.key(viewId, includeHidden));
  }

  set(viewId: string, includeHidden: boolean, rendered: string): void {
    const key = ReadBaselines.key(viewId, includeHidden);
    this.map.delete(key); // 重新插入 = 挪到最新
    this.map.set(key, rendered);
    while (this.map.size > BASELINES_MAX) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/** 进程唯一的一份（理由见文件头）。 */
export const readBaselines = new ReadBaselines();

/**
 * `since_last` 的输出。三种情形各自可辨：没有底稿（给全量）/ 没变化 / 变了哪些行。
 * `full` 是这次本来要回的那份（无底稿或比不了时退回它，并说明为什么）。
 */
export function renderSinceLast(prev: string | undefined, next: string, full: string): string {
  if (prev === undefined) {
    return `NOTE: no earlier browser_read of this view to compare against — full read below.\n\n${full}`;
  }
  const d = diffLines(prev, next);
  if (!d) return `NOTE: the page is too large to diff line by line — full read below.\n\n${full}`;
  if (!d.lines.length) return "No changes since the last browser_read of this view (same skeleton and text).";
  const shown = d.lines.slice(0, DIFF_MAX_SHOWN);
  const rest = d.lines.length - shown.length;
  return [
    `Changes since this view was last read with browser_read: ${d.added} line(s) added, ${d.removed} removed ` +
      `(- = was there before, + = is there now; unchanged lines omitted):`,
    ...shown,
    ...(rest > 0 ? [`… ${rest} more changed line(s) not shown — read without since_last for the whole page.`] : []),
  ].join("\n");
}
