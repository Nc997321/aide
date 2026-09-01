import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "./types.js";

/**
 * 模型切换守卫 — SDK 0.3.252 PreModelSwitch/PostModelSwitch hook 落地。
 *
 * PreModelSwitch：切换发生**前**用 SDK 报告的进程真相（缓存温度/上下文体量）裁决
 * 要不要打断用户确认；PostModelSwitch：切换真实完成后发坐实事件（前端据此落盘）。
 * 判定权在 SDK 真相，不在前端基线（旧「切换模型后发送弹窗」已随本设计废除）。
 */

/** 确认策略阈值（context_tokens 之下重铺成本可忽略，不打扰）。政策源：设计稿 §3。 */
export const CONFIRM_CONTEXT_TOKENS_THRESHOLD = 50_000;

/** 前端决策超时：超时按 deny 收尾（挂起不悬死）。政策源：设计稿 §4。 */
export const CONFIRM_DECISION_TIMEOUT_MS = 10_000;

/** PreModelSwitch 输入的事实袋（SDK 输入字段全可选，逐字段 typeof 收窄后的形状）。 */
export interface PreModelSwitchFacts {
  from_model?: unknown;
  to_model?: unknown;
  source?: unknown;
  context_tokens?: unknown;
  prompt_cache_warm?: unknown;
  estimated_cache_write_usd?: unknown;
  cache_ttl?: unknown;
}

/** 策略：是否需要用户确认。冷缓存重铺是必然成本（问了只烦）；热 + 大体量才问。 */
export function shouldConfirmModelSwitch(promptCacheWarm: boolean, contextTokens: number): boolean {
  return promptCacheWarm && contextTokens >= CONFIRM_CONTEXT_TOKENS_THRESHOLD;
}

/** SDK hook 输入 → 切换事实袋（Record 收窄是 SDK 库边界的既定例外，字段名穿透）。 */
export function extractSwitchFacts(input: HookInput): PreModelSwitchFacts {
  const r = input as Record<string, unknown>;
  return {
    from_model: r["from_model"],
    to_model: r["to_model"],
    source: r["source"],
    context_tokens: r["context_tokens"],
    prompt_cache_warm: r["prompt_cache_warm"],
    estimated_cache_write_usd: r["estimated_cache_write_usd"],
    cache_ttl: r["cache_ttl"],
  };
}

export interface ModelSwitchGuardDeps {
  /** 向前端发事件（SessionWorker 注入，DeltaCoalescer 汇聚红线）。 */
  emit: (e: ChatEvent) => void;
  /** 切换坐实回调（SessionWorker 注入：拼 current/broadcast 与前端事件）。 */
  onCommitted: (payload: { from: string; to: string; requested: string | null; source: string }) => void;
}

export interface ModelSwitchGuard {
  /** PreModelSwitch 回调（SDK 注册用）。 */
  preSwitchHook: HookCallback;
  /** PostModelSwitch 回调（切换坐实 → onCommitted 下游）。 */
  postSwitchHook: HookCallback;
  /** 前端确认决定入口（model_switch_confirm_decision 命令）。 */
  resolveConfirm(confirmId: string, approve: boolean): void;
  /** 会话停止/自建 query 结束时清理：挂起按 deny 收尾 + 清定时器。 */
  dispose(): void;
}

export function makeModelSwitchGuard(deps: ModelSwitchGuardDeps): ModelSwitchGuard {
  // 挂起槽（单槽：同一时刻至多一个确认在等）+ 其裁决通道与超时定时器。
  let pending: { resolve: (allow: boolean) => void } | null = null;
  let activeConfirmId = "";
  let timeoutTimer: NodeJS.Timeout | undefined;

  /** 裁决单点：无挂起时 no-op（前端决定晚到/重复是正常时序，不报错）。 */
  function settlePending(allow: boolean): void {
    if (!pending) return;
    clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
    const p = pending;
    pending = null;
    p.resolve(allow);
  }

  const preSwitchHook: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "PreModelSwitch") return {};
    const facts = extractSwitchFacts(input);
    const warm = facts.prompt_cache_warm === true;
    const tokens = typeof facts.context_tokens === "number" ? facts.context_tokens : 0;
    if (!shouldConfirmModelSwitch(warm, tokens)) return {};
    // 连续切换（旧确认还挂着）：旧请求按 deny 收尾，新请求接管槽位
    settlePending(false);

    activeConfirmId = `switch-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let release!: (allow: boolean) => void;
    const gate = new Promise<boolean>((r) => { release = r; });
    pending = { resolve: release };
    timeoutTimer = setTimeout(() => settlePending(false), CONFIRM_DECISION_TIMEOUT_MS);

    deps.emit({
      type: "model_switch_confirm",
      confirm_id: activeConfirmId,
      from_model: typeof facts.from_model === "string" ? facts.from_model : "",
      to_model: typeof facts.to_model === "string" ? facts.to_model : "",
      source: typeof facts.source === "string" ? facts.source : "sdk",
      context_tokens: tokens,
      prompt_cache_warm: warm,
      estimated_cache_write_usd:
        typeof facts.estimated_cache_write_usd === "number" ? facts.estimated_cache_write_usd : 0,
      cache_ttl: typeof facts.cache_ttl === "string" ? facts.cache_ttl : "5m",
    });

    const allow = await gate;
    if (!allow) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreModelSwitch" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: "用户取消了模型切换（缓存重铺成本确认）",
        },
      };
    }
    return {};
  };

  const postSwitchHook: HookCallback = async (input: HookInput) => {
    if (input.hook_event_name !== "PostModelSwitch") return {};
    const r = input as Record<string, unknown>;
    deps.onCommitted({
      from: typeof r["from_model"] === "string" ? r["from_model"] : "",
      to: typeof r["to_model"] === "string" ? r["to_model"] : "",
      requested: typeof r["requested_model"] === "string" ? r["requested_model"] : null,
      source: typeof r["source"] === "string" ? r["source"] : "",
    });
    return {};
  };

  return {
    preSwitchHook,
    postSwitchHook,
    resolveConfirm(confirmId: string, approve: boolean): void {
      // confirmId 对不上（过期的确认框晚点）不算数：只有当前挂起的 ID 能裁决
      if (pending && confirmId === activeConfirmId) settlePending(approve);
    },
    dispose(): void {
      settlePending(false);
      clearTimeout(timeoutTimer);
    },
  };
}