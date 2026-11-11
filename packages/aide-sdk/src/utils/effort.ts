/** effort 档位 → 前端显示名：快速(low) / 均衡(medium) / 进阶(high) / 极致(max)。
 *  桌面（ChatInputBox / ChatMessage 等）与远程 PWA（ChatView）共用此表，
 *  档位值域的演进只在此处发生。历史 xhigh（API 仍可能回报，如 max 静默降级）
 *  归一到极致显示，避免徽标/选择器出现用户没见过的档位名。 */
export const EFFORT_OPTIONS = [
  { value: "low", label: "快速" },
  { value: "medium", label: "均衡" },
  { value: "high", label: "进阶" },
  { value: "max", label: "极致" },
] as const;

export type EffortValue = (typeof EFFORT_OPTIONS)[number]["value"];

const EFFORT_LABELS: Record<string, string> = {
  low: "快速",
  medium: "均衡",
  high: "进阶",
  xhigh: "极致",
  max: "极致",
};

/** 档位值 → 显示名；未知值原样大写返回（如 API 回报的新档位）。 */
export function effortLabel(v: string): string {
  return EFFORT_LABELS[v.toLowerCase()] ?? v.toUpperCase();
}

/** 把任意档位值归一到选择器：历史 xhigh→极致（保留深度意图）；
 *  非法/空值 → "high"（选择器没有"默认"档，默认就落进阶）。 */
export function normalizeEffortOption(v: string | undefined | null): EffortValue {
  const raw = (v ?? "").trim().toLowerCase();
  if (raw === "low" || raw === "medium" || raw === "high" || raw === "max") return raw;
  if (raw === "xhigh") return "max";
  return "high";
}
