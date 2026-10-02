import type { KbRef } from "../types/chat";

/**
 * 「知识库圈选编辑」的进度事件（模块级小总线）。
 *
 * 为什么单独一条总线、而不是让文档面板去轮询或读聊天 store：文档面板要知道的只有三件事——
 * AI 开始改我圈的那段了 / 改完了（改成几版、有没有告警）/ 这一轮结束了（没改也要能收尾）。
 * 它们都来自聊天事件流（events.ts 在 tool_use_start / tool_result / message_stop 上发），
 * 事件通道本来就是多端一致的真相，这里只是把「edit_selection」这一类事件摘出来。
 */
export type KbSelectionEvent =
  | { kind: "working"; sid: string; selectionId: string }
  | {
      kind: "result";
      sid: string;
      selectionId: string;
      ok: boolean;
      /** 成功时：写入后的文档版本号。 */
      versionNo?: number;
      /** 成功但读回核对发现选区之外有出入（并发改动）。 */
      warning?: boolean;
      /** 失败时给用户看的原因（工具回的文本）。 */
      message?: string;
    }
  | { kind: "turn_end"; sid: string };

type Listener = (e: KbSelectionEvent) => void;
const listeners = new Set<Listener>();

export function onKbSelectionEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitKbSelectionEvent(e: KbSelectionEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(e);
    } catch (err) {
      console.warn("kb selection listener failed:", err);
    }
  }
}

const EDIT_TOOL = /(^|__)edit_selection$/;
export function isEditSelectionTool(name: string): boolean {
  return EDIT_TOOL.test(name);
}

/** edit_selection 的回执文本 → 结构化结果（成功回执以 "Edited the selection" 开头，见 sidecar operations.ts）。 */
export function parseEditSelectionResult(text: string, isError: boolean): { ok: boolean; versionNo?: number; warning?: boolean; message?: string } {
  const ok = !isError && /^Edited the selection/.test(text.trim());
  if (!ok) return { ok: false, message: text.trim().slice(0, 300) };
  const v = /\bversion (\d+)/.exec(text);
  return { ok: true, ...(v ? { versionNo: Number(v[1]) } : {}), ...(/WARNING/.test(text) ? { warning: true } : {}) };
}

/** 供类型引用（面板据此建模）。 */
export type { KbRef };
