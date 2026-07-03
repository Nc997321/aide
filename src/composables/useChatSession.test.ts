import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

// ── Tauri mocks ──
let chatEventHandler: ((e: { payload: Record<string, unknown> }) => void) | null = null;
const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    chatEventHandler = cb;
    return () => {
      chatEventHandler = null;
    };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useChatSession, __resetForTest } from "./useChatSession";
import { useSessionState } from "./useSessionState";

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: e });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

describe("useChatSession per-session store", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
  });

  it("后台会话的 message_stop 不会污染前台会话的消息（P0 缓存污染回归）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    await chat.sendMessage("hello A");
    emit({ type: "text_delta", delta: "A 的回复", session_id: "uuid-a" });

    // 切到 B，A 在后台完成
    sid.value = "uuid-b";
    await flush();
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
    await flush();

    // B 的消息列表必须为空（load_messages mock 返回 undefined → 空历史）
    expect(chat.messages.value).toEqual([]);

    // 切回 A，回复完整保留
    sid.value = "uuid-a";
    await flush();
    const texts = chat.messages.value.flatMap((m) => m.blocks).filter((b) => b.type === "text");
    expect(texts.some((b) => (b as { text: string }).text.includes("A 的回复"))).toBe(true);
  });

  it("后台会话的 text_delta / tool_use / tool_result 全部入库", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    sid.value = "uuid-b";
    await flush();

    emit({ type: "text_delta", delta: "后台文本", session_id: "uuid-a" });
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" }, session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t1", content: "ok", is_error: false, session_id: "uuid-a" });
    await flush();

    sid.value = "uuid-a";
    await flush();
    const blocks = chat.messages.value.flatMap((m) => m.blocks);
    expect(blocks.some((b) => b.type === "text" && (b as { text: string }).text === "后台文本")).toBe(true);
    const tool = blocks.find((b) => b.type === "tool_call") as
      | { result?: string; isPending?: boolean }
      | undefined;
    expect(tool?.result).toBe("ok");
    expect(tool?.isPending).toBe(false);
  });

  it("历史会话（UUID id）首次发送时把自身 id 作为 resume 传下去（P0 resume 断裂回归）", async () => {
    const sid = ref<string | null>("0f6d9a2e-1234-4abc-9def-000000000001");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("continue");

    const call = invokeMock.mock.calls.find((c) => c[0] === "send_message");
    expect(call?.[1]).toMatchObject({ resumeId: "0f6d9a2e-1234-4abc-9def-000000000001" });
  });

  it("sessionId 为空时首次发送现场生成临时 key，不带 resume；session_init 后触发首次创建，alias 转发在途事件", async () => {
    const sid = ref<string | null>(null);
    const chat = useChatSession(sid);
    const created = vi.fn();
    chat.onSessionCreated(created);
    await flush();

    const tempId = await chat.sendMessage("first");
    expect(tempId).toBeTruthy();

    const sendCall = invokeMock.mock.calls.find((c) => c[0] === "send_message");
    expect(sendCall?.[1]).toMatchObject({ sessionId: tempId, resumeId: null });

    emit({ type: "session_init", sdk_session_id: "sdk-uuid-1", session_id: tempId as string });
    await flush();

    expect(
      invokeMock.mock.calls.some(
        (c) => c[0] === "rename_sidecar_session" && (c[1] as { oldId?: string })?.oldId === tempId,
      ),
    ).toBe(true);
    // create_session/addSession/recordCurrentSession 现在是 App.vue 的职责，
    // 不在这个 composable 里发生——这里只验证运行时状态搬迁 + 回调触发。
    expect(created).toHaveBeenCalledWith(tempId, "sdk-uuid-1");

    // 首次创建后旧临时 key 事件经 alias 路由到新 store
    emit({ type: "text_delta", delta: "after", session_id: tempId as string });
    sid.value = "sdk-uuid-1";
    await flush();
    const blocks = chat.messages.value.flatMap((m) => m.blocks);
    expect(blocks.some((b) => b.type === "text" && (b as { text: string }).text === "after")).toBe(true);
  });

  it("后台会话的 permission_request 在切回时弹出（P1 死锁回归）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    sid.value = "uuid-b";
    await flush();
    emit({ type: "permission_request", id: "p1", name: "Bash", input: {}, session_id: "uuid-a" });
    await flush();
    expect(chat.pendingPermission.value).toBeNull();

    sid.value = "uuid-a";
    await flush();
    expect(chat.pendingPermission.value?.id).toBe("p1");
  });

  it("message_stop 置 waiting（通知链路回归）；error 置 stopped", async () => {
    const { state } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    expect(state["uuid-a"]).toBe("running");

    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
    await flush();
    expect(state["uuid-a"]).toBe("waiting");
    expect(chat.isBusy.value).toBe(false);

    await chat.sendMessage("q2");
    emit({ type: "error", message: "boom", session_id: "uuid-a" });
    await flush();
    expect(state["uuid-a"]).toBe("stopped");
  });

  it("permission_cancelled 清掉挂起的对话框", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "permission_request", id: "p1", name: "Bash", input: {}, session_id: "uuid-a" });
    await flush();
    expect(chat.pendingPermission.value?.id).toBe("p1");
    emit({ type: "permission_cancelled", id: "p1", session_id: "uuid-a" });
    await flush();
    expect(chat.pendingPermission.value).toBeNull();
  });

  it("models_available 更新可选模型列表和当前选中项", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    expect(chat.models.value).toEqual([]);

    emit({
      type: "models_available",
      models: [{ value: "sonnet", displayName: "Sonnet" }, { value: "opus", displayName: "Opus" }],
      current: "sonnet",
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.models.value).toEqual([{ value: "sonnet", displayName: "Sonnet" }, { value: "opus", displayName: "Opus" }]);
    expect(chat.currentModel.value).toBe("sonnet");
  });

  it("context_usage 更新会话的上下文窗口用量", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    expect(chat.contextUsage.value).toBeNull();

    emit({
      type: "context_usage",
      total_tokens: 52000,
      max_tokens: 100000,
      percentage: 52,
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.contextUsage.value).toEqual({ totalTokens: 52000, maxTokens: 100000, percentage: 52 });
  });

  it("message_stop 带 usage 时挂到最后一条 assistant 消息，并累加会话总费用", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "text_delta", delta: "回复", session_id: "uuid-a" });
    await flush();

    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0.0123,
    };
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: 0.0123, usage, session_id: "uuid-a" });
    await flush();

    expect(chat.totalCostUsd.value).toBe(0.0123);
    const last = chat.messages.value[chat.messages.value.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.usage).toEqual(usage);
    expect(last.streaming).toBe(false);
  });

  it("模型列表是 provider 级别的事实，尚未连上 SDK 的会话也能借用别的会话学到的列表", async () => {
    const sidA = ref<string | null>("uuid-a");
    const chatA = useChatSession(sidA);
    await flush();
    emit({
      type: "models_available",
      models: [{ value: "sonnet", displayName: "Sonnet" }],
      current: "sonnet",
      session_id: "uuid-a",
    });
    await flush();

    // uuid-b 从没收到过 models_available，但打开时应该直接看到 A 学到的列表
    const sidB = ref<string | null>("uuid-b");
    const chatB = useChatSession(sidB);
    await flush();
    expect(chatB.models.value).toEqual([{ value: "sonnet", displayName: "Sonnet" }]);
    // 但 B 自己还没选过模型，不应该被 A 的选择污染
    expect(chatB.currentModel.value).toBe("");
  });
});
