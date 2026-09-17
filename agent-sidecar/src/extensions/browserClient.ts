import { randomUUID } from "crypto";
import type { ChatEvent } from "../engine/types.js";

/**
 * 内嵌浏览器桥的客户端（sidecar 侧）。
 *
 * 形制照 `codegraphClient.ts`（同一套 request_id 配对模式）：工具 emit 一条 `browser_query`
 * 事件 → 桌面 Rust 的 `runtime/mod.rs` 拦截（不转发 Vue）→ `runtime/browser_agent.rs` 驱动门面
 * → 结果以 `browser_result` 经 stdin 回写 → 这里按 request_id 结算。
 *
 * **本模块只在桌面宿主有意义**：headless 没有 Rust 回包方，调用它只会等到超时——
 * 所以工具层必须在 headless 下**提前短路**（见 `browserTools.ts`）。
 */
export type BrowserOp = "list_views" | "eval" | "call_cdp";

/**
 * 一次桥调用。用联合而不是「op + 可选字段袋」：**非法组合造不出来**
 * （`list_views` 不可能带 `script`，`eval` 必须有 `script`）。
 */
export type BrowserCall =
  | { op: "list_views" }
  | { op: "eval"; view_id?: string; script: string }
  | { op: "call_cdp"; view_id?: string; method: string; params?: unknown };

export interface BrowserQueryResponse {
  ok: boolean;
  /** op 成功时的载荷。`list_views` → `{views}`；`eval`/`call_cdp` → `{view_id, value}`。 */
  data?: unknown;
  /** 失败原因，**面向模型可读**（Rust 侧保证是可指导下一步的文本，不是堆栈）。 */
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}

interface Pending {
  resolve: (r: BrowserQueryResponse) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/**
 * 客户端超时。
 *
 * **必须 > Rust adapter 的 `NATIVE_TIMEOUT`（10s）**——层级关系是有意的：让「视图不存在」
 * 「脚本报错」「CDP 域名不可用」这类**快错误以真实错误文本回到模型**，而不是被这里笼统兜底成
 * "timed out"。单改其一 = 错误信息退化（模型会以为浏览器卡了，实际是脚本写错了）。
 */
export const BROWSER_QUERY_TIMEOUT_MS = 15_000;

/** 发起一次桥调用。永不 reject——失败一律折成 `{ok:false}` 由工具层转成文本。 */
export function queryBrowser(
  call: BrowserCall,
  emit: (e: ChatEvent) => void,
): Promise<BrowserQueryResponse> {
  const request_id = randomUUID();
  // 必须走 worker 的 emit（→ DeltaCoalescer → stdout），禁止直写 process.stdout。
  emit({ type: "browser_query", request_id, ...call });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request_id);
      resolve({
        ok: false,
        timedOut: true,
        error:
          "browser bridge timed out — the desktop host did not reply " +
          "(is the embedded browser available in this environment?)",
      });
    }, BROWSER_QUERY_TIMEOUT_MS);
    pending.set(request_id, { resolve, timer });
  });
}

/** 结算一条 Rust 回包。未知/已超时/已取消的 id 静默丢弃。 */
export function resolveBrowserResult(cmd: {
  request_id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}): void {
  const p = pending.get(cmd.request_id);
  if (!p) return; // 未知/已超时/已取消——静默丢弃
  pending.delete(cmd.request_id);
  clearTimeout(p.timer);
  p.resolve({ ok: cmd.ok, data: cmd.data, error: cmd.error });
}

/** 会话停止/中断时清掉该进程内所有挂起查询（request_id 全局唯一，无需按会话分）。 */
export function cancelAllBrowserQueries(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, cancelled: true, error: reason });
  }
  pending.clear();
}
