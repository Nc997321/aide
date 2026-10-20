import { randomUUID } from "crypto";
import type { ChatEvent } from "../../engine/types.js";

/**
 * 电脑操作桥的客户端（sidecar 侧）。形制同内嵌浏览器桥（browserClient.ts）：
 * 工具 emit 一条 `computer_query` → 桌面进程（本机 Host：runtime hooks；远程 Host：经 Host 事件转到
 * 连着它的窗口）交给 aide-computer 执行 → 回包 `computer_result` 按 request_id 结算。
 *
 * 设计：docs/superpowers/specs/2026-10-19-computer-use-design.md
 */
export type ComputerCall =
  | { op: "windows" }
  | { op: "window"; action: string; window_id?: string; app?: string }
  | { op: "read"; window_id?: string; screenshot?: boolean; text_tail?: number; scope?: string; watch?: { label: string; every_ms: number } }
  | { op: "act"; window_id: string; intent: string; steps: unknown[] }
  | { op: "wait"; window_id?: string; condition: unknown; timeout_ms?: number };

export interface ComputerResponse {
  ok: boolean;
  data?: unknown;
  /** 面向模型可读（Rust 侧保证能指导下一步）。 */
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (r: ComputerResponse) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/**
 * 客户端超时：必须大于执行器里最长的一次操作（等待上限 60s；启动应用等 10s；打长文本），
 * 让执行器的真实结果（含「等待超时」）回到模型，而不是被这里笼统兜底。
 */
export function timeoutFor(call: ComputerCall): number {
  switch (call.op) {
    case "wait":
      return Math.min(call.timeout_ms ?? 10_000, 60_000) + 15_000;
    case "act":
    case "window":
      return 90_000;
    default:
      return 30_000;
  }
}

/** 发起一次桥调用。永不 reject——失败一律折成 `{ok:false}` 由工具层转成文本。 */
export function queryComputer(call: ComputerCall, emit: (e: ChatEvent) => void): Promise<ComputerResponse> {
  const request_id = randomUUID();
  // 必须走 worker 的 emit（带上 session_id：执行器的输入锁按会话），禁止直写 stdout。
  emit({ type: "computer_query", request_id, ...call });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      resolve({
        ok: false,
        timedOut: true,
        error: "The computer-use executor did not reply in time (is this session running inside the Aide desktop app?).",
      });
    }, timeoutFor(call));
    pending.set(request_id, { resolve, timer });
  });
}

/** 结算一条回包。未知 / 已超时 / 已取消的 id 静默丢弃。 */
export function resolveComputerResult(cmd: { request_id: string; ok: boolean; data?: unknown; error?: string }): void {
  const p = pending.get(cmd.request_id);
  if (!p) return;
  pending.delete(cmd.request_id);
  clearTimeout(p.timer);
  p.resolve({ ok: cmd.ok, data: cmd.data, error: cmd.error });
}

/** 中断 / 停止时清掉挂起查询（同 cancelAllBrowserQueries）。执行器那头由「一轮结束」事件让进行中的等待收手。 */
export function cancelAllComputerQueries(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, cancelled: true, error: reason });
  }
  pending.clear();
}
