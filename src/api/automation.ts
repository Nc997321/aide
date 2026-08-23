/** 自动化任务的 invoke 封装 + 线类型（与 src-tauri/src/automation/ 的 serde camelCase 对齐）。
 *  垂直领域子 API 范式，参照 api/customization.ts。 */
import { invoke } from "@tauri-apps/api/core";

/** 权限预设：auto = CLI 自动裁决（安全放行/高危兜底拒绝，默认）；full = 完全访问。 */
export type PermissionPreset = "auto" | "full";
export type MissedPolicy = "catchup" | "skip" | "ask";
export type PlaybookState = "none" | "ready" | "stale";
export type RunTrigger = "schedule" | "manual" | "catchup";
export type RunMode = "explore" | "playbook";
export type RunStatus = "running" | "succeeded" | "failed" | "skipped";
export type IntervalUnit = "minutes" | "hours" | "days";

export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: number[] } // 1=周一..7=周日
  | { kind: "monthly"; time: string; day: number }
  | { kind: "interval"; every: number; unit: IntervalUnit }
  | { kind: "once"; at: string };

export interface AutomationTask {
  id: string;
  name: string;
  prompt: string;
  workspacePath: string | null;
  model: string;
  effort: string;
  permissionPreset: PermissionPreset;
  connectors: string[];
  schedule: Schedule;
  validFrom: string | null;
  validTo: string | null;
  missedPolicy: MissedPolicy;
  playbookEnabled: boolean;
  playbookState: PlaybookState;
  notifySuccess: boolean;
  notifyFailure: boolean;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
}

/** create/update 入参：id、createdAt、lastRun 系、playbookState 由服务端管理。 */
export interface AutomationTaskInput {
  name: string;
  prompt: string;
  workspacePath: string | null;
  model: string;
  effort: string;
  permissionPreset: PermissionPreset;
  connectors: string[];
  schedule: Schedule;
  validFrom: string | null;
  validTo: string | null;
  missedPolicy: MissedPolicy;
  playbookEnabled: boolean;
  notifySuccess: boolean;
  notifyFailure: boolean;
  enabled: boolean;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface RunRecord {
  runId: string;
  sessionId: string;
  trigger: RunTrigger;
  mode: RunMode;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  stopReason: string | null;
  usage: RunUsage | null;
  rounds: number | null;
  costUsd: number | null;
  /** 结论摘要（转录尾行，≤80 字）；skipped/运行中为 null */
  summary: string | null;
  distillCostUsd: number | null;
  error: string | null;
  note: string | null;
}

export interface RunStats {
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number;
  totalCostUsd: number;
  avgDurationMs: number | null;
  cacheReadRatio: number | null;
}

export const automationApi = {
  list: () => invoke<AutomationTask[]>("list_automations"),
  get: (id: string) => invoke<AutomationTask>("get_automation", { id }),
  create: (input: AutomationTaskInput) => invoke<AutomationTask>("create_automation", { input }),
  update: (id: string, input: AutomationTaskInput) =>
    invoke<AutomationTask>("update_automation", { id, input }),
  remove: (id: string) => invoke<void>("delete_automation", { id }),
  setEnabled: (id: string, enabled: boolean) =>
    invoke<AutomationTask>("set_automation_enabled", { id, enabled }),
  runNow: (id: string) => invoke<RunRecord>("run_automation_now", { id }),
  runs: (id: string, limit?: number) => invoke<RunRecord[]>("list_automation_runs", { id, limit }),
  stats: (id: string) => invoke<RunStats>("automation_run_stats", { id }),
  /** None = 手册尚未生成 */
  playbook: (id: string) => invoke<string | null>("get_automation_playbook", { id }),
  redistill: (id: string) => invoke<AutomationTask>("redistill_automation", { id }),
};
