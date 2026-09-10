import type { TaskItem } from "./types.js";

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"]);
const TASK_STATUSES = new Set(["pending", "in_progress", "completed"]);

interface PendingCreate {
  subject: string;
  activeForm?: string;
}

/** 从 TaskCreate 的 tool_result content 提取分配到的 taskId。
 *  SDK 0.3.197 起 tool_result 是纯文本 "Task #N created successfully: <subject>"
 *  （0.3.142 文档所述的 JSON { task: { id, subject } } 形状已不再使用）。
 *  无法匹配时返回 undefined，调用方静默丢弃，不影响主对话流。纯函数，单独测试。 */
export function extractCreatedTaskId(content: string): string | undefined {
  const m = content.match(/Task\s+#?(\d+)\s+created successfully/i);
  return m ? m[1] : undefined;
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
  /** 标记「下一轮首个新 task 落地时清空旧 task 列表（覆盖）」。由 markResetOnNextCreate
   *  设置，handleToolResult 在插入首个新 task 前消费并置 false。不立即清 tasks——
   *  让旧轮 TODO 在过渡期仍可见，且新轮 TaskUpdate 推进旧 task 时旧 taskId 仍在表
   *  里能命中（见 markResetOnNextCreate 的说明）。 */
  private resetOnNextCreate = false;

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

    const taskId = extractCreatedTaskId(content);
    if (!taskId) return { tracked: true, changed: false }; // 解析失败静默丢弃，不影响主对话流
    // 新轮首个新 task 落地：清空旧轮 task 列表（覆盖），而非追加。一轮内后续
    // TaskCreate 标志已置 false，直接追加，不重复清。
    if (this.resetOnNextCreate) {
      this.tasks.clear();
      this.resetOnNextCreate = false;
    }
    this.tasks.set(taskId, {
      id: taskId,
      subject: pending.subject,
      status: "pending",
      activeForm: pending.activeForm,
    });
    return { tracked: true, changed: true };
  }

  snapshot(): TaskItem[] {
    return [...this.tasks.values()];
  }

  /** 清空全部任务状态——已落地的任务、待解析的 TaskCreate、以及已登记的
   *  工具 id。在每轮用户消息开始时调用，让新一轮的 TODO 覆盖旧轮而不是追加
   *  （TaskTracker 的 Map 默认只增不清，旧轮已完成的任务会一直留在快照里，
   *  导致顶部 TODO 越积越长）。reset 后迟到的旧 tool_result 不会被当作任务
   *  工具的结果吞掉（trackedIds 已清），而是回退为通用 tool_result 路径。 */
  reset(): void {
    this.tasks.clear();
    this.pendingCreates.clear();
    this.trackedIds.clear();
  }

  /** 新一轮用户消息开始时调用：标记下一轮首个新 task 落地时覆盖式清空旧 task，
   *  但不立即清 tasks——让旧轮 TODO 在 Claude 还没响应的过渡期仍可见，且新轮
   *  Claude 用 TaskUpdate 推进旧 task 时旧 taskId 仍在表里能命中（原 reset() 会
   *  把旧 taskId 清掉，导致 TaskUpdate 在下方 handleToolUse 被防御性丢弃、todo
   *  推进信号被吞——保留 tasks 正好修这个）。pendingCreates / trackedIds 仍清，
   *  保留原 reset 的跨轮迟到 tool_result 防御（迟到结果不再被认作任务工具结果，
   *  回退通用 tool_result 路径）。 */
  markResetOnNextCreate(): void {
    this.resetOnNextCreate = true;
    this.pendingCreates.clear();
    this.trackedIds.clear();
  }
}
