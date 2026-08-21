/** effort 档位 → 前端显示名。三档制：快速(low) / 思考(high) / 深度思考(max)。
 *  medium/xhigh 是历史遗留档位（API 仍可能回报，如 max 静默降级 xhigh），
 *  映射到相邻档位显示，避免徽标/抽屉出现用户没见过的档位名。 */
export const EFFORT_OPTIONS = [
  { value: "low", label: "快速" },
  { value: "high", label: "思考" },
  { value: "max", label: "深度思考" },
];

const EFFORT_LABELS: Record<string, string> = {
  low: "快速",
  medium: "思考",
  high: "思考",
  xhigh: "深度思考",
  max: "深度思考",
};

/** 档位值 → 显示名；未知值原样大写返回（如 API 回报的新档位）。 */
export function effortLabel(v: string): string {
  return EFFORT_LABELS[v.toLowerCase()] ?? v.toUpperCase();
}

/** 把任意档位值归一到三档制：历史 medium→思考、xhigh→深度思考（保留深度意图）；
 *  非法/空值 → "high"（选择器没有"默认"档，默认就落思考）。 */
export function normalizeEffortOption(v: string | undefined | null): string {
  const raw = (v ?? "").trim().toLowerCase();
  if (raw === "low" || raw === "high" || raw === "max") return raw;
  if (raw === "medium") return "high";
  if (raw === "xhigh") return "max";
  return "high";
}
