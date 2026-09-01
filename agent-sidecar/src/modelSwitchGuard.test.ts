import { describe, it, expect, vi, afterEach } from "vitest";
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  makeModelSwitchGuard,
  shouldConfirmModelSwitch,
  CONFIRM_CONTEXT_TOKENS_THRESHOLD,
  CONFIRM_DECISION_TIMEOUT_MS,
  type ChatEvent,
} from "./modelSwitchGuard.js";

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
  });
  return { guard, pre: guard.preSwitchHook, post: guard.postSwitchHook, committed, events };
}

async function preResult(pre: HookCallback, input: HookInput): Promise<Record<string, unknown>> {
  return (await pre(input)) as Record<string, unknown>;
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
    }, "PostModelSwitch"));
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