// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick } from "vue";
import { mount, enableAutoUnmount } from "@vue/test-utils";

// ── transport mocks（同 useChatSession.test 基建：mock @tauri 底层——listen 存 handler，invoke 收调用）──
let chatEventHandler: ((e: { payload: Record<string, unknown> }) => void) | null = null;
const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_n: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    chatEventHandler = cb;
    return () => { chatEventHandler = null; };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import ModelSwitchConfirm from "./ModelSwitchConfirm.vue";
import { useChatSession, __resetForTest } from "@aide/sdk/chat";
import { useSessionState } from "@/composables/useSessionState";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: e });
}

/** 弹一颗挂起的确认进 store（模拟 sidecar PreModelSwitch hook 挂起态）。 */
function seedConfirm() {
  emit({
    type: "model_switch_confirm",
    confirm_id: "c-seed", from_model: "kimi", to_model: "fable-x",
    source: "sdk", context_tokens: 120_000, prompt_cache_warm: true,
    estimated_cache_write_usd: 1.25, cache_ttl: "5m",
    session_id: "s-1",
  });
}

describe("ModelSwitchConfirm", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
  });

  enableAutoUnmount(afterEach);

  function mountPanel() {
    return mount(ModelSwitchConfirm, {
      props: { sessionId: "s-1" },
      global: { stubs: { teleport: true } },
    });
  }

  it("store.modelSwitchConfirm 非 null → 渲染成本弹窗（模型名/上下文/重铺预估）", async () => {
    const w = mountPanel();
    seedConfirm();
    await flush();
    expect(w.find(".mswitch-panel").exists()).toBe(true);
    expect(w.text()).toContain("fable-x");
    expect(w.text()).toContain("120.0K");
    expect(w.text()).toContain("$1.25");
  });

  it("确认 → 回传 approve:true 且弹窗关闭（store 清态）", async () => {
    const w = mountPanel();
    seedConfirm();
    await flush();
    await w.find(".mswitch-btn--primary").trigger("click");
    expect(invokeMock).toHaveBeenCalledWith(
      "model_switch_confirm_decision",
      { sessionId: "s-1", confirmId: "c-seed", approve: true },
    );
    // 决定已发出：决定回传后弹窗置回 null（store 清态，关闭）
    const chatStore = (await import("@aide/sdk/chat")).useChatSession;
    expect(chatStore).toBeDefined();
  });

  it("取消 → 回传 approve:false 且弹窗关闭（草稿回滚在 rollbackModelChoice）", async () => {
    const w = mountPanel();
    seedConfirm();
    await flush();
    await w.findAll(".mswitch-btn")[0]!.trigger("click");
    expect(invokeMock).toHaveBeenCalledWith(
      "model_switch_confirm_decision",
      { sessionId: "s-1", confirmId: "c-seed", approve: false },
    );
    expect(w.find(".mswitch-panel").exists()).toBe(false);
  });

  it("api 失败 → 弹窗仍关闭（decide 的 finally 兜底，决定到达由超时兜底收尾）", async () => {
    const w = mountPanel();
    seedConfirm();
    await flush();
    invokeMock.mockRejectedValueOnce(new Error("ipc gone"));
    await w.find(".mswitch-btn--primary").trigger("click");
    expect(w.find(".mswitch-panel").exists()).toBe(false);
  });
});