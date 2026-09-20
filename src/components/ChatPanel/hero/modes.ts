/**
 * 新建对话页的两种模式。加第三种的前提是它有**真实的行为差异**（文案池 / 默认档位 /
 * 落点 / 右栏策略四轴里至少一条），不接受只有文案不同的装饰性模式 —— 对照 2026-09-20
 * 删掉的那批假控件。
 *
 * 模式的选中态**不在这里**：它由落点派生（isDailyKey(pendingWs.wsKey)），见 PaneGroup。
 * 设计见 docs/superpowers/specs/2026-09-20-daily-mode-design.md
 */
export type HeroMode = "daily" | "project";

export interface HeroModeSpec {
  readonly id: HeroMode;
  readonly label: string;
}

export const HERO_MODES: readonly HeroModeSpec[] = [
  { id: "daily", label: "日常" },
  { id: "project", label: "工程" },
];

export const DEFAULT_HERO_MODE: HeroMode = "daily";
