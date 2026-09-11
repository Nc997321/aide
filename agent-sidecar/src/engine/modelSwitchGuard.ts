import type {
  HookCallback,
  HookInput,
  PreModelSwitchHookInput,
  PostModelSwitchHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, ModelOption } from "./types.js";

/** PostModelSwitch 坐实载荷（SDK 预声明的切换来源枚举随 source 透传）。 */
export interface ModelCommittedPayload {
  from: string;
  to: string;
  requested: string | null;
  source: "command" | "picker" | "sdk" | "auto" | "resume";
}

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

/** 策略：是否需要用户确认。冷缓存重铺是必然成本（问了只烦）；热 + 大体量才问。 */
export function shouldConfirmModelSwitch(promptCacheWarm: boolean, contextTokens: number): boolean {
  return promptCacheWarm && contextTokens >= CONFIRM_CONTEXT_TOKENS_THRESHOLD;
}

export interface ModelSwitchGuardDeps {
  /** 向前端发事件（SessionWorker 注入，DeltaCoalescer 汇聚红线）。 */
  emit: (e: ChatEvent) => void;
  /** 切换坐实回调（SessionWorker 注入：拼 current 账面与前端事件）。source 同 SDK 枚举。 */
  onCommitted: (payload: ModelCommittedPayload) => void;
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
    // SDK 类型已精确声明该判别成员的全部字段（PreModelSwitchHookInput，含
    // requested_model: string | null）——判别收窄后编译器可推，无需 typeof 阶梯。
    const facts = input as PreModelSwitchHookInput;
    if (!shouldConfirmModelSwitch(facts.prompt_cache_warm, facts.context_tokens)) return {};
    // 连续切换（旧确认还挂着）：旧请求按 deny 收尾，新请求接管槽位
    settlePending(false);

    activeConfirmId = `switch-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // release! 非空断言：Promise executor 同步执行，gate 构造后必已赋值
    let release!: (allow: boolean) => void;
    const gate = new Promise<boolean>((r) => { release = r; });
    pending = { resolve: release };
    timeoutTimer = setTimeout(() => settlePending(false), CONFIRM_DECISION_TIMEOUT_MS);

    deps.emit({
      type: "model_switch_confirm",
      confirm_id: activeConfirmId,
      from_model: facts.from_model,
      to_model: facts.to_model,
      source: facts.source,
      context_tokens: facts.context_tokens,
      prompt_cache_warm: facts.prompt_cache_warm,
      estimated_cache_write_usd: facts.estimated_cache_write_usd,
      cache_ttl: facts.cache_ttl,
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
    const facts = input as PostModelSwitchHookInput;
    deps.onCommitted({
      from: facts.from_model,
      to: facts.to_model,
      requested: facts.requested_model,
      source: facts.source,
    });
    return {};
  };

  return {
    preSwitchHook,
    postSwitchHook,
    resolveConfirm(confirmId: string, approve: boolean): void {
      // confirmId 对不上（过期的确认框晚到）不算数：只有当前挂起的 ID 能裁决
      if (pending && confirmId === activeConfirmId) settlePending(approve);
    },
    dispose(): void {
      settlePending(false);
      clearTimeout(timeoutTimer);
    },
  };
}
// ---- worker 侧坐实回执处理（session-worker.makeModelSwitchGuard 的 onCommitted
//      闭包迁出，拆分批 3，纯移动）----

/** 坐实回执处理的依赖：名册查询与账面写入都由 worker 注入（模型名册与
 *  currentModel 账面归 worker 所有，本模块只编排事件语义）。 */
export interface RosterCommitDeps {
  emit: (e: ChatEvent) => void;
  /** wire id → 下拉 value 归一（ModelRoster.resolveDropdownValue）。 */
  resolveDropdown: (wire: string) => string;
  /** 可选模型列表（ModelRoster.models 活值）。 */
  models: () => readonly ModelOption[];
  /** 账面写入（worker 的 currentModel）。 */
  setModel: (realName: string) => void;
}

export function makeRosterCommitHandler(
  deps: RosterCommitDeps,
): (p: ModelCommittedPayload) => void {
  return (p) => {
    // requested 是用户命名空间（下拉别名，restoreModel 可恢复）——优先落账；
    // to_model 是 CLI resolved 全名，经 resolveDropdownValue 归一回下拉 value。
    // 账面（currentModel）与回执只在用户显式切换（source='sdk'）时更新/发出：
    // resume/auto 是 CLI 内部动作（恢复会话/自动兜底），发 ok 回执会让前端弹
    // 用户没做的「已切换」提示，且 resolved 全名直写账面会与下拉别名命名空间
    // 混注（同值守卫跨命名空间比较会误吞/漏判）。
    const value = p.requested ?? deps.resolveDropdown(p.to);
    const display = deps.models().find((m) => m.value === value)?.displayName ?? value;
    deps.emit({
      type: "model_committed",
      from_model: p.from,
      to_model: p.to,
      requested_model: p.requested,
      source: p.source,
    });
    if (p.source === "sdk") {
      if (value) deps.setModel(value);
      // 回执=事实：成功回执由 model_committed 到达驱动（setModel.then 直发会把
      //「hook 阻塞中/未生效」当成功——设计稿 §3 的回执换轴）
      deps.emit({ type: "model_switch_result", ok: true, model: value, display });
    }
  };
}
