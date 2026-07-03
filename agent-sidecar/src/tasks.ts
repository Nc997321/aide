import type { TaskItem } from "./types.js";

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"]);
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

interface PendingCreate {
  subject: string;
  activeForm?: string;
}

export interface ToolResultOutcome {
  /** true 表示这个 tool_use_id 属于 Task 工具，调用方不应再转发通用 tool_result 事件。 */
  tracked: boolean;
  /** true 表示任务清单发生了变化，调用方应该发一次 tasks_update 快照。 */
  changed: boolean;
}

/** 累加 Claude Agent SDK 的 Task 工具（TaskCreate/TaskUpdate/TaskGet/TaskList）
 *  状态，对外只暴露 provider-agnostic 的 TaskItem 快照。 */
export class TaskTracker {
  private tasks = new Map<string, TaskItem>();
  private pendingCreates = new Map<string, PendingCreate>();
  /** 记录这 4 个工具的 tool_use_id，好在对应 tool_result 到达时判断要不要吞掉。 */
  private trackedIds = new Set<string>();

  static isTaskTool(name: string): boolean {
    return TASK_TOOL_NAMES.has(name);
  }

  /** 返回 true 时调用方应该发一次 tasks_update 快照。 */
  handleToolUse(id: string, name: string, input: unknown): boolean {
    this.trackedIds.add(id);
    const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

    if (name === "TaskCreate") {
      const activeForm = typeof record.activeForm === "string" ? record.activeForm : undefined;
      this.pendingCreates.set(id, { subject: String(record.subject ?? ""), activeForm });
      return false; // taskId 要等 tool_result 才知道
    }

    if (name === "TaskUpdate") {
      const taskId = (record.taskId ?? record.id ?? record.task_id) as string | undefined;
      if (!taskId) return false;
      const existing = this.tasks.get(taskId);
      if (!existing) return false; // 没见过的 id，防御性丢弃

      if (record.status === "deleted") {
        this.tasks.delete(taskId);
        return true;
      }
      if (typeof record.status === "string" && TASK_STATUSES.has(record.status)) {
        existing.status = record.status as TaskItem["status"];
      }
      if (typeof record.subject === "string") existing.subject = record.subject;
      const activeForm = record.activeForm ?? record.active_form;
      if (typeof activeForm === "string") existing.activeForm = activeForm;
      return true;
    }

    return false; // TaskGet / TaskList：只读，不产生状态变化
  }

  /** tracked=false 表示这不是任务工具的结果，调用方应照旧转发通用 tool_result；
   *  changed=true 表示状态变了，调用方应该发一次 tasks_update 快照。 */
  handleToolResult(id: string, content: string): ToolResultOutcome {
    if (!this.trackedIds.delete(id)) return { tracked: false, changed: false };

    const pending = this.pendingCreates.get(id);
    if (!pending) return { tracked: true, changed: false }; // TaskUpdate/TaskGet/TaskList 的结果
    this.pendingCreates.delete(id);

    try {
      const parsed = JSON.parse(content) as { task?: { id?: string; subject?: string } };
      const taskId = parsed.task?.id;
      if (!taskId) return { tracked: true, changed: false };
      this.tasks.set(taskId, {
        id: taskId,
        subject: parsed.task?.subject ?? pending.subject,
        status: "pending",
        activeForm: pending.activeForm,
      });
      return { tracked: true, changed: true };
    } catch {
      return { tracked: true, changed: false }; // 解析失败静默丢弃，不影响主对话流
    }
  }

  snapshot(): TaskItem[] {
    return [...this.tasks.values()];
  }
}
