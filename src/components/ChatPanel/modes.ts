/**
 * 新建对话页的两种模式（与"这个会话属于哪一类"同义，故不止 hero 在用）。
 * 加第三种的前提是它有**真实的行为差异**（文案池 / 默认档位 /
 * 落点 / 右栏策略四轴里至少一条），不接受只有文案不同的装饰性模式 —— 对照 2026-09-20
 * 删掉的那批假控件。
 *
 * 模式的选中态**不在这里**：它由落点派生（isDailyKey(pendingWs.wsKey)），见 PaneGroup。
 * 设计见 docs/superpowers/specs/2026-09-20-daily-mode-design.md
 */
export type ChatMode = "daily" | "project";

export interface ChatModeSpec {
  readonly id: ChatMode;
  readonly label: string;
}

export const CHAT_MODES: readonly ChatModeSpec[] = [
  { id: "daily", label: "日常" },
  { id: "project", label: "工程" },
];

export const DEFAULT_CHAT_MODE: ChatMode = "daily";
