// 与 codegraphClient 同构：emit 一个带 request_id 的事件出去，主进程处理后经命令通道
// 回 `lsp_result`，这里按 id 结算。
//
// 超时预算 120s（codegraph 是 10s）：冷启动实测 46–73s（见
// docs/superpowers/spikes/2026-09-19-lsp-agent-tools/），主进程还要跑一次就绪探测。
// 10s 会让每次冷启动查询都超时——那正是本设计要消灭的失败模式。
import { randomUUID } from "crypto";
import type { ChatEvent } from "../engine/types.js";

export type LspTool = "symbols" | "references" | "definition" | "implementations" | "warm";
// `warm` 不是给模型的工具，是 sidecar 在会话早期 fire-and-forget 的预热（见 session-worker）。

export interface LspQueryResponse {
  ok: boolean;
  status: string;
  results?: unknown[];
  count?: number;
  /** 同名多义：`candidates` 是候选清单，模型须自己读代码消歧（见 agent_query.rs）。 */
  ambiguous?: boolean;
  candidates?: unknown[];
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (r: LspQueryResponse) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

export const LSP_QUERY_TIMEOUT_MS = 120_000;

export function queryLsp(
  tool: LspTool,
  args: Record<string, unknown>,
  workspaceRoot: string,
  emit: (e: ChatEvent) => void,
): Promise<LspQueryResponse> {
  const request_id = randomUUID();
  // 必须走 worker 的 emit（→ DeltaCoalescer → stdout），禁止直写 process.stdout。
  emit({ type: "lsp_query", request_id, tool, args, workspace_root: workspaceRoot });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      resolve({ ok: false, status: "timeout", timedOut: true, error: "timeout" });
    }, LSP_QUERY_TIMEOUT_MS);
    pending.set(request_id, { resolve, timer });
  });
}

export function resolveLspResult(cmd: {
  request_id: string;
  ok: boolean;
  status?: string;
  results?: unknown[];
  count?: number;
  ambiguous?: boolean;
  candidates?: unknown[];
  error?: string;
}): void {
  const p = pending.get(cmd.request_id);
  if (!p) return; // 未知/已超时/已取消——静默丢弃
  pending.delete(cmd.request_id);
  clearTimeout(p.timer);
  p.resolve({
    ok: cmd.ok,
    status: cmd.status ?? (cmd.ok ? "ready" : "error"),
    results: cmd.results,
    count: cmd.count,
    ambiguous: cmd.ambiguous,
    candidates: cmd.candidates,
    error: cmd.error,
  });
}

/** 会话停止/中断时清掉本进程内所有挂起查询（request_id 全局唯一，无需按会话分）。 */
export function cancelAllLspQueries(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, status: "error", cancelled: true, error: reason });
  }
  pending.clear();
}
