/**
 * 上下文用量展示的纯逻辑层：分类归桶、token 格式化、百分比钳制。
 *
 * 归桶策略：SDK/CLI 报的分类名（categories[].name）会随版本微调，且明细行比
 * 原型的 5 类聚合更细——按名称关键词宽匹配归桶 + 兜底灰保证任何名字都落得进
 * 色板。槽位契约：颜色跟着实体走（chart1=系统提示、chart2=工具、chart3=消息、
 * chart4=MCP、chart5=技能，主题 token 槽位见 src/themes/tokens.ts），类别缺席
 * 不重排不换色。未知名/溢出全部落 --aide-chart-fallback 兜底灰。
 */

interface CategoryBucket {
  readonly slot: 1 | 2 | 3 | 4 | 5;
  /** 小写关键词（includes 匹配）；先命中先归桶，keys 顺序即优先级。 */
  readonly keys: readonly string[];
}

const CATEGORY_BUCKETS: readonly CategoryBucket[] = [
  { slot: 4, keys: ["mcp"] },
  { slot: 5, keys: ["skill"] },
  { slot: 1, keys: ["prompt"] },
  { slot: 2, keys: ["tool"] },
  { slot: 3, keys: ["message", "conversation", "history", "chat"] },
];

/** 分类名 → 语义 token 变量。分段条段色与明细列表 dot 共用，保证两处同源。
 *  本质：分类名到主题色板 token 的解析器（未知名落兜底灰）。
 *  归桶表是颜色跟实体走的政策载体，政策源见设计稿 2026-09-01 §3.3/§4。 */
export function chartVarFor(name: string): string {
  const n = name.toLowerCase();
  for (const b of CATEGORY_BUCKETS) {
    if (b.keys.some((k) => n.includes(k))) return `var(--aide-chart${b.slot})`;
  }
  return "var(--aide-chart-fallback)";
}

/** token 数 → 紧凑文本（11000→"11.0K"、125500→"125.5K"、220→"220"），口径同原型。 */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** 百分比钳到 [0,100]——进度环/分段条的轨道守卫，越界值是渲染问题不是数据问题。 */
export function clampPct(p: number): number {
  return Math.min(100, Math.max(0, p));
}