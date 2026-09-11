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

/**
 * 用户切换意图追踪器（因果门纯核心）。PreModelSwitch 的 source 枚举只有
 * command/picker/sdk，而进程内部对账（respawn 重带 options.model、网关驳回后的
 * 回落重启）同样戴 sdk 标签——枚举区分不了「用户点了下拉」与「进程自己对账」，
 * 只有因果能区分：worker 在发 setModel 前记意图，PreModelSwitch 到达时把 to_model
 * 归一回真名与意图比对（归一由持有名册的 worker 做，本追踪器只认真名）。
 */
export function createUserSwitchIntentTracker(now: () => number = Date.now) {
  let intent: { model: string; at: number } | null = null;
  return {
    /** worker 发 setModel 前记一笔（仅 query 在跑时记——deferred 分支无 hook）。 */
    note(model: string): void {
      intent = { model, at: now() };
    },
    /** 单次消费：命中/过期/不匹配都清意图——残留意图不得误认下一次对账切换。 */
    take(resolvedToRealName: string, ttlMs: number = CONFIRM_DECISION_TIMEOUT_MS): boolean {
      const cur = intent;
      intent = null;
      if (!cur) return false;
      if (now() - cur.at > ttlMs) return false;
      return resolvedToRealName === cur.model;
    },
  };
}

export interface ModelSwitchGuardDeps {
  /** 向前端发事件（SessionWorker 注入，DeltaCoalescer 汇聚红线）。 */
  emit: (e: ChatEvent) => void;
  /** 切换坐实回调（SessionWorker 注入：拼 current 账面与前端事件）。source 同 SDK 枚举。 */
  onCommitted: (payload: ModelCommittedPayload) => void;
  /** 因果门：本次 PreModelSwitch 是否 worker 刚发起的用户切换（to_model 已归一真名）。
   *  否 = 进程内部对账切换，静默放行不打扰用户（2026-09-11 双弹窗事故）。 */
  consumeUserSwitchIntent: (resolvedToRealName: string) => boolean;
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
    // 因果门（先于成本策略无意义——策略已过才问）：非 worker 发起的切换（进程 respawn
    // 重带 options.model、网关驳回后回落重启等内部对账）静默放行——给用户弹「切到他
    // 没选的模型」的确认既误导又把内部对账挂起 10s（2026-09-11 双弹窗事故）。
    if (!deps.consumeUserSwitchIntent(facts.to_model)) return {};
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
    // 账面/显示/回执值一律取**真名命名空间**：to_model 是进程真实切到的 resolved
    // wire 名（事实），经 resolveDropdown 归一回下拉 value。requested_model 是 CLI
    // **别名命名空间**回显（还可能被 CLI 归一成默认别名）——拿它落账曾造成裸别名
    // 上屏 + 下拉选中值掉出选项集合（2026-09-11 sonnet 事故），现降级为纯信息
    // 字段随 model_committed 原样透传，不进账面。
    // 账面（currentModel）与回执只在用户显式切换（source='sdk'）时更新/发出：
    // resume/auto 是 CLI 内部动作（恢复会话/自动兜底），发 ok 回执会让前端弹
    // 用户没做的「已切换」提示。
    const value = deps.resolveDropdown(p.to);
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
