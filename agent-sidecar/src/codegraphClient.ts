import { randomUUID } from "crypto";
import type { ChatEvent } from "./types.js";

export type CodegraphTool = "find_symbol" | "semantic_search" | "call_graph";

export interface CodegraphQueryResponse {
  ok: boolean;
  status: string;
  results?: unknown[];
  candidates?: number;
  truncated?: boolean;
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (r: CodegraphQueryResponse) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

// SDK 文档：MCP 工具调用超时默认无界（MCP_TOOL_TIMEOUT），所以这里必须自管。
// 10s 对内存查询 + 一次 embed 绰绰有余；超时后 agent 拿文本提示退回 Grep。
export const CODEGRAPH_QUERY_TIMEOUT_MS = 10_000;

export function queryCodegraph(
  tool: CodegraphTool,
  args: Record<string, unknown>,
  projectRoot: string,
  emit: (e: ChatEvent) => void,
): Promise<CodegraphQueryResponse> {
  const request_id = randomUUID();
  // 必须走 worker 的 emit（→ DeltaCoalescer → stdout），禁止直写 process.stdout。
  emit({ type: "codegraph_query", request_id, tool, args, project_root: projectRoot });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      resolve({ ok: false, status: "error", timedOut: true, error: "timeout" });
    }, CODEGRAPH_QUERY_TIMEOUT_MS);
    pending.set(request_id, { resolve, timer });
  });
}

export function resolveCodegraphResult(cmd: {
  request_id: string;
  ok: boolean;
  status?: string;
  results?: unknown[];
  candidates?: number;
  truncated?: boolean;
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
    candidates: cmd.candidates,
    truncated: cmd.truncated,
    error: cmd.error,
  });
}

/** 会话停止/中断时清掉该进程内所有挂起查询（request_id 全局唯一，无需按会话分）。 */
export function cancelAllCodegraphQueries(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, status: "error", cancelled: true, error: reason });
  }
  pending.clear();
}
