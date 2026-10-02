// emit 一个带 request_id 的事件出去，主进程处理后经命令通道
// 回 `lsp_result`，这里按 id 结算。
//
// **每次查询都有预算**（默认 120s 只给预热用）。真机转录（2026-09-29 统计）：一发 LSP
// 等 20–60s 换一句「没答上」，几次之后 agent 就再也不碰这组工具——所以给模型的查询
// 一律带短预算，超了由 lspNav 用文本兜底当场作答（见 lspNav.ts），主进程那头的等待
// 也按 `budget_ms` 收口（agent_query.rs 的 `budget`）。
import { randomUUID } from "crypto";
import type { ChatEvent } from "../engine/types.js";

export type LspTool =
  | "symbols"
  | "references"
  | "definition"
  | "implementations"
  | "outline"
  | "text"
  | "warm";
// `warm` 不是给模型的工具，是 sidecar 在会话早期 fire-and-forget 的预热（见 session-worker）。
// `outline` / `text` 是 lspNav 组装答案用的零件（文件结构 / 文本兜底），见 agent_nav.rs。

export interface LspQueryResponse {
  ok: boolean;
  status: string;
  results?: unknown[];
  count?: number;
  /** 同名多义：`candidates` 是候选清单，模型须自己读代码消歧（见 agent_query.rs）。 */
  ambiguous?: boolean;
  candidates?: unknown[];
  /** `outline` 的文件结构（agent_nav.rs 的 OutlineNode）。 */
  symbols?: unknown[];
  /** `text` 的文本命中（agent_nav.rs 的 TextHit）。 */
  matches?: unknown[];
  truncated?: boolean;
  /** `warm` 的逐语言状态。 */
  languages?: unknown[];
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (r: LspQueryResponse) => void;
  timer: NodeJS.Timeout;
  root: string;
}

const pending = new Map<string, Pending>();

/** 预热的等待上限：冷启动实测 46–73s，主进程还要跑一次就绪探测。 */
export const LSP_QUERY_TIMEOUT_MS = 120_000;

/** 哪些工作区根的语言服务器**已经答过一次 ready**。grep 顺带作答的快路径只在这里开
 *  （lspGlance.ts）：冷窗口里给每次 grep 加几秒等待，是把 agent 推离 grep 之外的代价。 */
const readyRoots = new Set<string>();

export function isLspWarm(workspaceRoot: string): boolean {
  return readyRoots.has(workspaceRoot);
}

export interface QueryOptions {
  /** 本端等待上限；同时作为 `budget_ms` 递给主进程（后端的等待也跟着收口）。 */
  timeoutMs?: number;
}

export function queryLsp(
  tool: LspTool,
  args: Record<string, unknown>,
  workspaceRoot: string,
  emit: (e: ChatEvent) => void,
  opts: QueryOptions = {},
): Promise<LspQueryResponse> {
  const request_id = randomUUID();
  const timeoutMs = opts.timeoutMs ?? LSP_QUERY_TIMEOUT_MS;
  // 后端预算比本端略短：让主进程先收口、回一个带状态的答案，而不是本端先超时丢掉它。
  const wireArgs = opts.timeoutMs ? { ...args, budget_ms: Math.max(500, timeoutMs - 1500) } : args;
  // 必须走 worker 的 emit（→ DeltaCoalescer → stdout），禁止直写 process.stdout。
  emit({ type: "lsp_query", request_id, tool, args: wireArgs, workspace_root: workspaceRoot });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      resolve({ ok: false, status: "timeout", timedOut: true, error: "timeout" });
    }, timeoutMs);
    pending.set(request_id, { resolve, timer, root: workspaceRoot });
  });
}

export function resolveLspResult(cmd: {
  request_id: string;
  ok: boolean;
  status?: string;
  error?: string;
  [key: string]: unknown;
}): void {
  const p = pending.get(cmd.request_id);
  if (!p) return; // 未知/已超时/已取消——静默丢弃
  pending.delete(cmd.request_id);
  clearTimeout(p.timer);
  // 整包透传：各工具的载荷键不同（results / candidates / symbols / matches / languages），
  // 逐键抄写就是每加一个工具漏一次（outline 的 `symbols` 就是这么丢过的形状）。
  const { cmd: _cmd, request_id: _id, ...payload } = cmd;
  const status = cmd.status ?? (cmd.ok ? "ready" : "error");
  if (status === "ready") readyRoots.add(p.root);
  p.resolve({ ...(payload as Partial<LspQueryResponse>), ok: cmd.ok, status });
}

/** 会话停止/中断时清掉本进程内所有挂起查询（request_id 全局唯一，无需按会话分）。 */
export function cancelAllLspQueries(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, status: "error", cancelled: true, error: reason });
  }
  pending.clear();
}

/** 测试用：重置就绪记录。 */
export function _resetLspWarmForTest(): void {
  readyRoots.clear();
}
