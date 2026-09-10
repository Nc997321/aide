import type { ChatEvent } from "./types.js";

/**
 * stdout 帧写入的背压/缓冲上限控制——sidecar stdio 协议出口的最后一层。
 *
 * 问题（2026-08-23 审查 P0-1）：Rust reader 挂起（或 UI 主线程阻塞）时，Node 对
 * process.stdout 的缓冲无限增长 → OOM，且 OOM 死亡前不发任何错误帧，Rust 只能靠
 * 看门狗超时判死。这里把写出口收拢成 writeStdoutFrame，加背压检测与上限：
 *
 * - write() 返回 false = 内核缓冲满。注意 Node 仍会排队已写入的数据（返回 false
 *   只是"满了慢点写"的提示），真正能省的是【下次】写入时跳过增量帧——所以
 *   "丢弃"发生在 backpressured=true 期间对增量帧直接不写。
 * - 增量事件（text_delta/thinking_delta/subagent_*_delta/bg_task_output）与心跳在
 *   背压期间直接丢弃——丢了语义无损（增量可合并、心跳仅活性证明）。非增量事件
 *   （终态/错误等）照常写入（Node 内部 FIFO 缓冲，事件间相对顺序保持）。
 * - 丢弃计数 ≥ MAX_DROPPED_BEFORE_NOTIFY 时通知调用方发一条 error 帧说明背压降级。
 * - 首次背压起 DRAIN_TIMEOUT_MS 内无 drain → 判定对端真挂：通知调用方发错误帧并
 *   置 fatal，此后所有输出静默丢弃（防缓冲无限增长 OOM）。
 *
 * 与 Rust 看门狗的关系：心跳是增量帧，背压期间被丢弃 = 对端 15s 收不到任何行 →
 * 看门狗判死重启。这正是预期的恢复路径（对端真挂时重启进程比无限缓冲更可取）。
 */

/** 背压期间累积丢弃的增量帧达到此数时，通知调用方发一条 error 帧（降级可见化）。 */
const MAX_DROPPED_BEFORE_NOTIFY = 1000;
/** 背压持续超过此毫秒数仍无 drain → 熔断（发 error 帧 + 停止一切输出）。 */
const DRAIN_TIMEOUT_MS = 5_000;

/** 背压期间可丢弃的帧类型：丢了语义无损（增量文本/心跳）。 */
const DROPPABLE_TYPES: ReadonlySet<string> = new Set([
  "text_delta",
  "thinking_delta",
  "subagent_text_delta",
  "subagent_thinking_delta",
  "bg_task_output",
  "heartbeat",
]);

let backpressured = false;
let droppedCount = 0;
let fatal = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
/** 背压降级/熔断的通知回调（SessionManager 注入：组装带会话上下文的 error 帧）。 */
let notify: ((message: string, sessionId: string | undefined) => void) | null = null;

/** 该事件类型在背压期间是否可丢弃（增量文本/心跳）。 */
export function isDroppableEvent(event: ChatEvent): boolean {
  return DROPPABLE_TYPES.has(event.type);
}

/** 注入背压通知回调（生产由 index.ts 提供；测试可不设）。 */
export function setStdoutBackpressureNotifier(
  fn: ((message: string, sessionId: string | undefined) => void) | null,
): void {
  notify = fn;
}

/** 当前是否处于背压态（诊断/测试用）。 */
export function stdoutBackpressured(): boolean {
  return backpressured;
}

/** 是否已熔断（诊断/测试用）。 */
export function stdoutFatal(): boolean {
  return fatal;
}

/**
 * 写一帧到 stdout。返回 false = 该帧因背压被丢弃（仅增量/心跳帧会丢）。
 *
 * @param sessionId 正在写入的会话路由键（供背压通知携带上下文；心跳等进程级帧不传）。
 */
export function writeStdoutFrame(line: string, droppable: boolean, sessionId?: string): boolean {
  if (fatal) return false; // 已熔断：一切输出静默丢弃（防缓冲无限增长 OOM）
  if (backpressured && droppable) {
    droppedCount += 1;
    if (droppedCount >= MAX_DROPPED_BEFORE_NOTIFY) {
      droppedCount = 0;
      notify?.(`stdout 背压降级：对端读取过慢，已丢弃 ${MAX_DROPPED_BEFORE_NOTIFY} 条增量事件`, sessionId);
    }
    return false;
  }
  const flushed = process.stdout.write(line);
  if (flushed) return true;
  // 内核缓冲满：进入背压态。挂一次 drain 监听 + 超时熔断（非增量帧仍照常写入，
  // 由 Node 内部 FIFO 缓冲，顺序保持——"等待 drain" 语义由超时熔断兜底实现）。
  if (!backpressured) {
    backpressured = true;
    process.stdout.once("drain", onDrain);
    drainTimer = setTimeout(enterFatal, DRAIN_TIMEOUT_MS);
    drainTimer.unref?.();
  }
  return true;
}

function onDrain(): void {
  backpressured = false;
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
}

function enterFatal(): void {
  if (fatal) return;
  fatal = true;
  backpressured = false;
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  notify?.("stdout 背压超时（对端 5s 未读取）：已熔断输出，后续事件静默丢弃", undefined);
}

/** 测试专用：重置模块状态（vitest 也可用 vi.resetModules + 重新 import 替代）。 */
export function __resetStdoutStateForTest(): void {
  backpressured = false;
  droppedCount = 0;
  fatal = false;
  if (drainTimer !== null) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
}
