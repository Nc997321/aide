import { describe, it, expect, vi, afterEach } from "vitest";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  createUserSwitchIntentTracker,
  makeModelSwitchGuard,
  makeRosterCommitHandler,
  shouldConfirmModelSwitch,
  CONFIRM_CONTEXT_TOKENS_THRESHOLD,
  CONFIRM_DECISION_TIMEOUT_MS,
} from "./modelSwitchGuard.js";
import type { ModelCommittedPayload } from "./modelSwitchGuard.js";
import type { ChatEvent } from "./types.js";

/**
 * 模型切换守卫的分支覆盖：策略三臂（冷放行/热小体量放行/热大体量询问）、
 * 前端裁决回传（allow/deny/过期 ID）、连续切换旧请求接管、超时兜底、dispose。
 */

function switchInput(facts: Record<string, unknown>, event = "PreModelSwitch"): HookInput {
  return { hook_event_name: event, ...facts } as unknown as HookInput;
}

interface Harness {
  guard: ReturnType<typeof makeModelSwitchGuard>;
  pre: HookCallback;
  post: HookCallback;
  events: ChatEvent[];
  committed: { from: string; to: string; requested: string | null; source: string }[];
}

function makeHarness(): Harness {
  const events: ChatEvent[] = [];
  const committed: Harness["committed"] = [];
  const guard = makeModelSwitchGuard({
    emit: (e) => events.push(e),
    onCommitted: (p) => committed.push(p),
    consumeUserSwitchIntent: () => true,
  });
  return { guard, pre: guard.preSwitchHook, post: guard.postSwitchHook, committed, events };
}

/** HookCallback 三参签名：工具缝参数（toolUseID/options）对守卫无意义，测试桩给空值。 */
async function preResult(pre: HookCallback, input: HookInput): Promise<Record<string, unknown>> {
  return (await pre(input, undefined, { signal: new AbortController().signal })) as Record<string, unknown>;
}

function denyDecisionOf(result: Record<string, unknown>): string | undefined {
  return (result.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;
}

describe("shouldConfirmModelSwitch — 策略三臂", () => {
  it("冷缓存 → 放行（重铺是必然成本，不打扰）", () => {
    expect(shouldConfirmModelSwitch(false, 900_000)).toBe(false);
  });
  it("热缓存 + 小体量 → 放行", () => {
    expect(shouldConfirmModelSwitch(true, CONFIRM_CONTEXT_TOKENS_THRESHOLD - 1)).toBe(false);
  });
  it("热缓存 + 达到阈值 → 询问", () => {
    expect(shouldConfirmModelSwitch(true, CONFIRM_CONTEXT_TOKENS_THRESHOLD)).toBe(true);
  });
});

describe("makeModelSwitchGuard", () => {
  afterEach(() => vi.useRealTimers());

  it("非 PreModelSwitch 事件零表态", async () => {
    const { pre, events } = makeHarness();
    expect(await preResult(pre, switchInput({ hook_event_name: "PreToolUse" }))).toEqual({});
    expect(events).toHaveLength(0);
  });

  it("冷缓存 → 空对象放行，不发确认事件", async () => {
    const { pre, events } = makeHarness();
    const r = await preResult(pre, switchInput({ prompt_cache_warm: false, context_tokens: 999_999 }));
    expect(r).toEqual({});
    expect(events).toHaveLength(0);
  });

  it("因果门：无 worker 意图（进程内部对账切换）→ 热缓存大体量也静默放行（双弹窗事故回归）", async () => {
    const events: ChatEvent[] = [];
    const guard = makeModelSwitchGuard({
      emit: (e) => events.push(e),
      onCommitted: () => {},
      consumeUserSwitchIntent: () => false,
    });
    const r = await preResult(
      guard.preSwitchHook,
      switchInput({ prompt_cache_warm: true, context_tokens: 80_000 }),
    );
    expect(r).toEqual({});
    expect(events).toHaveLength(0);
  });

  it("热缓存大体量 → emit 确认事件并挂起；deny 决定返回 deny 输出", async () => {
    const h = makeHarness();
    const p = preResult(h.pre, switchInput({
      prompt_cache_warm: true, context_tokens: 120_000,
      from_model: "sonnet", to_model: "fable-x",
      estimated_cache_write_usd: 1, cache_ttl: "5m", source: "sdk",
    }));
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    const ev = h.events[0] as Extract<ChatEvent, { type: "model_switch_confirm" }>;
    expect(ev.context_tokens).toBe(120_000);
    expect(ev.estimated_cache_write_usd).toBe(1);
    expect(ev.from_model).toBe("sonnet");
    expect(ev.cache_ttl).toBe("5m");
    h.guard.resolveConfirm(ev.confirm_id, false);
    expect(denyDecisionOf(await p)).toBe("deny");
  });

  it("allow 决定 → 零表态（SDK 默认放行）", async () => {
    const h = makeHarness();
    const p = preResult(h.pre, switchInput({ prompt_cache_warm: true, context_tokens: 80_000 }));
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.guard.resolveConfirm((h.events[0] as { confirm_id: string }).confirm_id, true);
    expect(await p).toEqual({});
  });

  it("过期 confirmId 不得裁决当前挂起，由超时兜底按 deny 收口", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const p = preResult(h.pre, switchInput({ prompt_cache_warm: true, context_tokens: 80_000 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(h.events).toHaveLength(1);
    h.guard.resolveConfirm("switch-confirm-stale", true);
    await vi.advanceTimersByTimeAsync(CONFIRM_DECISION_TIMEOUT_MS + 1);
    expect(denyDecisionOf(await p)).toBe("deny");
  });

  it("连续切换：旧挂起按 deny 接管，新确认事件发出", async () => {
    const h = makeHarness();
    const p1 = preResult(h.pre, switchInput({ prompt_cache_warm: true, context_tokens: 80_000 }));
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    const p2 = preResult(h.pre, switchInput({ prompt_cache_warm: true, context_tokens: 90_000 }));
    await vi.waitFor(() => expect(h.events).toHaveLength(2));
    expect(denyDecisionOf(await p1)).toBe("deny");
    h.guard.resolveConfirm((h.events[1] as { confirm_id: string }).confirm_id, true);
    expect(await p2).toEqual({});
  });

  it("PostModelSwitch 分流：坐实转发给 onCommitted", async () => {
    const { post, committed, events } = makeHarness();
    await post(switchInput({
      from_model: "sonnet", to_model: "fable-x", requested_model: "fable", source: "sdk",
    }, "PostModelSwitch"), undefined, { signal: new AbortController().signal });
    expect(committed).toEqual([{ from: "sonnet", to: "fable-x", requested: "fable", source: "sdk" }]);
    expect(events).toHaveLength(0);
  });

  it("dispose：挂起按 deny 收尾，后续决定成 no-op", async () => {
    const h = makeHarness();
    const p = preResult(h.pre, switchInput({ prompt_cache_warm: true, context_tokens: 80_000 }));
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    h.guard.dispose();
    expect(denyDecisionOf(await p)).toBe("deny");
    expect(() => h.guard.resolveConfirm("x", true)).not.toThrow();
  });
});

describe("createUserSwitchIntentTracker：因果门纯核心", () => {
  it("note 后同真名 take 命中", () => {
    const t = createUserSwitchIntentTracker(() => 1000);
    t.note("qwen3.8-flash");
    expect(t.take("qwen3.8-flash")).toBe(true);
  });

  it("take 单次消费：命中后再 take 为 false", () => {
    const t = createUserSwitchIntentTracker(() => 1000);
    t.note("m");
    expect(t.take("m")).toBe(true);
    expect(t.take("m")).toBe(false);
  });

  it("不匹配也清意图（残留意图不得误认下一次对账切换）", () => {
    const t = createUserSwitchIntentTracker(() => 1000);
    t.note("qwen3.8-flash");
    expect(t.take("qwen3.8-max")).toBe(false);
    expect(t.take("qwen3.8-flash")).toBe(false);
  });

  it("超确认窗过期：false", () => {
    let clock = 1000;
    const t = createUserSwitchIntentTracker(() => clock);
    t.note("m");
    clock += CONFIRM_DECISION_TIMEOUT_MS + 1;
    expect(t.take("m")).toBe(false);
  });

  it("无意图：false", () => {
    const t = createUserSwitchIntentTracker(() => 1000);
    expect(t.take("m")).toBe(false);
  });
});

describe("makeRosterCommitHandler：账面/显示值真名命名空间归一", () => {
  interface CommitHarness {
    handler: (p: ModelCommittedPayload) => void;
    events: ChatEvent[];
    ledger: string[];
  }

  /** resolveDropdown 桩复刻 ModelRoster.resolveDropdownValue 语义（全等 + 前缀归一）。 */
  function makeCommitHarness(realModels: string[]): CommitHarness {
    const events: ChatEvent[] = [];
    const ledger: string[] = [];
    const handler = makeRosterCommitHandler({
      emit: (e) => events.push(e),
      resolveDropdown: (wire) =>
        realModels.find((r) => wire === r || wire.startsWith(`${r}-`)) ?? wire,
      models: () => realModels.map((value) => ({ value, displayName: `DN-${value}` })),
      setModel: (m) => {
        ledger.push(m);
      },
    });
    return { handler, events, ledger };
  }

  function resultOf(events: ChatEvent[]): Extract<ChatEvent, { type: "model_switch_result" }> {
    return events.find((e) => e.type === "model_switch_result") as Extract<
      ChatEvent,
      { type: "model_switch_result" }
    >;
  }

  it("sdk 源：账面/回执取 resolveDropdown(to_model)，忽略 requested 别名回显（sonnet 事故回归）", () => {
    const { handler, events, ledger } = makeCommitHarness(["qwen3.8-max"]);
    handler({ from: "qwen3.8-flash", to: "qwen3.8-max", requested: "sonnet", source: "sdk" });
    expect(ledger).toEqual(["qwen3.8-max"]);
    const result = resultOf(events);
    expect(result.ok).toBe(true);
    expect(result.model).toBe("qwen3.8-max");
    expect(result.display).toBe("DN-qwen3.8-max");
  });

  it("wire 变体后缀归一回下拉 value", () => {
    const { handler, ledger } = makeCommitHarness(["qwen3.8-max"]);
    handler({ from: "a", to: "qwen3.8-max-cloud", requested: null, source: "sdk" });
    expect(ledger).toEqual(["qwen3.8-max"]);
  });

  it("model_committed 原样透传 requested（信息字段，不进账面）", () => {
    const { handler, events } = makeCommitHarness(["qwen3.8-max"]);
    handler({ from: "a", to: "qwen3.8-max", requested: "sonnet", source: "sdk" });
    const committed = events.find((e) => e.type === "model_committed") as Extract<
      ChatEvent,
      { type: "model_committed" }
    >;
    expect(committed.requested_model).toBe("sonnet");
  });

  it("非 sdk 源：不写账面、不发 ok 回执，model_committed 照发", () => {
    const { handler, events, ledger } = makeCommitHarness(["qwen3.8-max"]);
    handler({ from: "a", to: "qwen3.8-max", requested: null, source: "resume" });
    expect(ledger).toEqual([]);
    expect(events.filter((e) => e.type === "model_switch_result")).toHaveLength(0);
    expect(events.filter((e) => e.type === "model_committed")).toHaveLength(1);
  });

  it("to 不在名册：原值兜底，display 等于 value", () => {
    const { handler, events, ledger } = makeCommitHarness(["sonnet"]);
    handler({ from: "a", to: "brand-new-model", requested: null, source: "sdk" });
    expect(ledger).toEqual(["brand-new-model"]);
    expect(resultOf(events).display).toBe("brand-new-model");
  });

  it("to 退化空值：不写账面（防御臂），回执照发", () => {
    const { handler, events, ledger } = makeCommitHarness(["sonnet"]);
    handler({ from: "a", to: "", requested: null, source: "sdk" });
    expect(ledger).toEqual([]);
    expect(resultOf(events).ok).toBe(true);
  });
});
