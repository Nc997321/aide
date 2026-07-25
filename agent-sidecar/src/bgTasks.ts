import type { ChatEvent } from "./types.js";

/**
 * 后台 shell 任务追踪器（per-session，纯状态、不碰 IO——tail 的启动/停止由调用方
 * 通过返回值决定，对齐 TaskTracker 的"返回 outcome、调用方发事件"模式）。
 *
 * 生命周期（两个信号源都能到，顺序不保证，全部按 id upsert）：
 *  1. system/task_started（task_type === "local_bash"）→ registerStarted
 *  2. Bash tool_result 的后台回执文本（"Command running in background with ID: …
 *     Output is being written to: …"）→ registerAck（拿到 outputFile，可以开始 tail）
 *  3. system/task_notification → handleNotification（终态，调用方停 tail）
 */

/** 后台回执的两种变体（claude.exe 二进制里实锤的原文）：
 *  变体一：Command running in background with ID: <id>. Output is being written to: <path>. You will be notified when it completes. …
 *  变体二：… ID: <id>. Output is being written to: <path>（行尾/串尾结束，无 notified 后缀）
 *  路径可能带空格（用户目录含空格时），所以懒匹配到「. You will be notified」或行尾，
 *  再剥掉句末句号。 */
export function parseBackgroundAck(content: string): { taskId: string; outputFile: string } | null {
  if (!content.includes("Output is being written to:")) return null;
  const m = content.match(/\bID:\s*(\S+?)\.\s+Output is being written to:\s*(.+?)(?:\.\s+You will be notified|\r?\n|$)/);
  if (!m) return null;
  let outputFile = m[2].trim();
  if (outputFile.endsWith(".")) outputFile = outputFile.slice(0, -1); // 句末标点，不是路径一部分
  if (!outputFile) return null;
  return { taskId: m[1], outputFile };
}

interface BgTaskRecord {
  id: string;
  toolUseId?: string;
  command?: string;
  description?: string;
  outputFile?: string;
  done: boolean;
}

/** 任务终态取值（TaskOutput 结果 / 通知 XML 共用）：killed 在 finalize 里归一为 stopped。 */
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "killed", "stopped"]);

export class BgTaskTracker {
  private tasks = new Map<string, BgTaskRecord>();
  /** Bash tool_use 的入参暂存（tool_use_id → command/description/runInBackground）。
   *  FIFO 上限防泄漏。 */
  private bashInputs = new Map<string, { command?: string; description?: string; runInBackground: boolean }>();
  private static readonly BASH_INPUTS_CAP = 100;

  /** assistant 分支里每个 Bash tool_use 都顺手登记。runInBackground 是后台判定的
   *  权威依据——CLI 的任务体系对【前台】Bash 同样发 system/task_started（前台命令
   *  也建临时 .output、跑完即删），task_type 都是 "local_bash"，靠 task_type 根本
   *  分不出前后台（2026-07-25 实锤：误把前台命令登记成后台任务，面板有任务、
   *  输出永远空白）。 */
  noteBashToolUse(toolUseId: string, input: unknown): void {
    const rec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    if (this.bashInputs.size >= BgTaskTracker.BASH_INPUTS_CAP) {
      const oldest = this.bashInputs.keys().next().value;
      if (oldest !== undefined) this.bashInputs.delete(oldest);
    }
    this.bashInputs.set(toolUseId, {
      command: typeof rec.command === "string" ? rec.command : undefined,
      description: typeof rec.description === "string" ? rec.description : undefined,
      runInBackground: rec.run_in_background === true,
    });
  }

  /** system/task_started：只登记「发起它的 Bash tool_use 带 run_in_background:true」
   *  的任务。前台 Bash 的 task_started（同上注释）、非 Bash 任务（local_agent /
   *  local_workflow）、ambient（skip_transcript）一律忽略；tool_use_id 未知的也
   *  忽略——真正的后台任务一定会从 tool_result 后台回执路径入列（双保险）。 */
  registerStarted(msg: any): ChatEvent | null {
    const taskId = msg.task_id as string | undefined;
    if (!taskId || msg.skip_transcript === true) return null;
    const toolUseId = msg.tool_use_id as string | undefined;
    if (!toolUseId) return null;
    const bash = this.bashInputs.get(toolUseId);
    if (!bash?.runInBackground) return null;

    const rec = this.upsert(taskId);
    rec.toolUseId = toolUseId;
    if (bash.command) rec.command = bash.command;
    const description = (typeof msg.description === "string" && msg.description) || bash.description;
    if (description) rec.description = description;
    return this.startedEvent(rec);
  }

  /** Bash tool_result 的后台回执：合并 tracker、关联 tool_use_id ↔ task_id。
   *  返回 upsert 事件 + outputFile（调用方据此启动 tail）；不是后台回执返回 null。 */
  registerAck(toolUseId: string, content: string): { event: ChatEvent; taskId: string; outputFile: string } | null {
    const ack = parseBackgroundAck(content);
    if (!ack) return null;
    const bash = this.bashInputs.get(toolUseId);
    const rec = this.upsert(ack.taskId);
    rec.toolUseId = toolUseId;
    if (bash?.command) rec.command = bash.command;
    if (bash?.description && !rec.description) rec.description = bash.description;
    rec.outputFile = ack.outputFile;
    this.bashInputs.delete(toolUseId); // 已关联，暂存没用了
    return { event: this.startedEvent(rec), taskId: ack.taskId, outputFile: ack.outputFile };
  }

  /** system/task_notification：只处理 tracker 里有的（别的任务类型——async 子代理等——
   *  走各自既有通道，不能在这里吞掉）。返回终态事件；不认识返回 null。 */
  handleNotification(msg: any): ChatEvent | null {
    const taskId = msg.task_id as string | undefined;
    if (!taskId) return null;
    const durationMs = typeof msg.usage?.duration_ms === "number" ? msg.usage.duration_ms : undefined;
    const summary = typeof msg.summary === "string" && msg.summary ? msg.summary : undefined;
    return this.finalize(taskId, msg.status as string | undefined, summary, durationMs);
  }

  /** <task-notification> XML 通道的终态——local_bash 的结束通知实际走这里（2026-07-25
   *  真实转录实锤：后台命令完成时 CLI 往父会话消息流注入 XML 用户消息，和 async 子代理
   *  同一条通道；structured system/task_notification 不发）。status 取值含 killed，
   *  归一到 stopped（对齐 CLI 的显示逻辑：killed 显示为 stopped）。 */
  handleXmlNotification(taskId: string, status: string | undefined, summary?: string): ChatEvent | null {
    return this.finalize(taskId, status, summary || undefined, undefined);
  }

  /** TaskOutput 工具结果里的终态——模型用 TaskOutput(block:true) 主动等任务结束的
   *  流程下，结果已同步交给模型，CLI 不一定再注入 <task-notification> XML（2026-07-25
   *  实锤：第六轮测试任务卡 running）。结果形如
   *  `<retrieval_status>success</retrieval_status> <task_id>…</task_id> <status>completed</status>…`。
   *  非终态（running 等）或未跟踪任务返回 null。 */
  handleTaskOutputResult(content: string): { event: ChatEvent; taskId: string } | null {
    if (!content.includes("<retrieval_status>")) return null;
    // 注意标签是下划线 task_id（通知 XML 用的是连字符 task-id，两处不同）
    const taskId = content.match(/<task_id>([^<]+)<\/task_id>/)?.[1]?.trim();
    if (!taskId) return null;
    const status = content.match(/<status>([^<]+)<\/status>/)?.[1]?.trim();
    if (!status || !TERMINAL_TASK_STATUSES.has(status)) return null;
    const ev = this.finalize(taskId, status, undefined, undefined);
    return ev ? { event: ev, taskId } : null;
  }

  /** structured system/task_updated：patch.status 是结构化终态字段（比文本通道可靠），
   *  CLI 若发这条就是首选信号；非终态 patch（description/is_backgrounded 等）忽略。 */
  handleTaskUpdated(msg: any): ChatEvent | null {
    const taskId = msg.task_id as string | undefined;
    const status = msg.patch?.status as string | undefined;
    if (!taskId || !status || !TERMINAL_TASK_STATUSES.has(status)) return null;
    return this.finalize(taskId, status, undefined, undefined);
  }

  /** 会话终结（session_stop / claude.exe 死亡）兜底：进程没了，所有 running 任务
   *  一律标记 stopped——否则它们会永远卡在「运行中」。返回要 emit 的终态事件列表。 */
  stopAllRunning(): ChatEvent[] {
    const events: ChatEvent[] = [];
    for (const rec of this.tasks.values()) {
      if (rec.done) continue;
      const ev = this.finalize(rec.id, "stopped", undefined, undefined);
      if (ev) events.push(ev);
    }
    return events;
  }

  private finalize(taskId: string, rawStatus: string | undefined, summary?: string, durationMs?: number): ChatEvent | null {
    const rec = this.tasks.get(taskId);
    if (!rec || rec.done) return null;
    rec.done = true;
    const status = rawStatus === "failed" ? "failed" : rawStatus === "stopped" || rawStatus === "killed" ? "stopped" : "completed";
    return { type: "bg_task_ended", id: taskId, status, ...(summary ? { summary } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  private upsert(taskId: string): BgTaskRecord {
    let rec = this.tasks.get(taskId);
    if (!rec) {
      rec = { id: taskId, done: false };
      this.tasks.set(taskId, rec);
    }
    return rec;
  }

  private startedEvent(rec: BgTaskRecord): ChatEvent {
    return {
      type: "bg_task_started",
      id: rec.id,
      ...(rec.toolUseId ? { toolUseId: rec.toolUseId } : {}),
      ...(rec.command ? { command: rec.command } : {}),
      ...(rec.description ? { description: rec.description } : {}),
      ...(rec.outputFile ? { outputFile: rec.outputFile } : {}),
    };
  }
}
