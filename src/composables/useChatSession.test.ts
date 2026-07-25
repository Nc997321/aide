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

    // Agent Runtime 重构后：re-key 在 SessionManager 内存里做（worker 的 Map
    // key 从 tempId 原子迁到 SDK realId），前端 finalizeSession 不再 invoke
    // rename_sidecar_session（该命令已删除）。确认旧命令不再被调用；首次创建
    // 由 onSessionCreated 回调通知 App.vue 完成（见下一断言）。
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "rename_sidecar_session"),
    ).toBe(false);
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

  it("可恢复错误(fatal:false)落 waiting + health warning，状态点投影为红(warning)", async () => {
    const { state, health, dotTone } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "error", message: "boom", fatal: false, session_id: "uuid-a" });
    await flush();
    // 进程仍活 → 活跃度落 waiting（不再谎报 stopped），健康度 warning，投影红点
    expect(state["uuid-a"]).toBe("waiting");
    expect(health["uuid-a"]).toBe("warning");
    expect(dotTone("uuid-a")).toBe("warning");
    expect(chat.isBusy.value).toBe(false);
  });

  it("image_input_rejected 解除 busy，保留会话以发送下一条纯文本", async () => {
    const { state, health } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("分析图片", {
      images: [{ data: "not-used", mediaType: "image/png" }],
    });
    expect(chat.isBusy.value).toBe(true);

    emit({ type: "image_input_rejected", message: "当前模型不支持图片输入", session_id: "uuid-a" });
    await flush();

    expect(chat.isBusy.value).toBe(false);
    expect(state["uuid-a"]).toBe("waiting");
    expect(health["uuid-a"]).toBe("warning");
    const lastMessage = chat.messages.value[chat.messages.value.length - 1];
    expect(lastMessage?.blocks).toContainEqual({ type: "text", text: "当前模型不支持图片输入" });

    await chat.sendMessage("只发文本");
    expect(state["uuid-a"]).toBe("running");
  });

  it("红点(warning)在下一条消息发出时清除，回到 running/绿", async () => {
    const { health, dotTone } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "error", message: "boom", fatal: false, session_id: "uuid-a" });
    await flush();
    expect(dotTone("uuid-a")).toBe("warning");

    await chat.sendMessage("q2");
    expect(health["uuid-a"]).toBe("ok");
    expect(dotTone("uuid-a")).toBe("running");
  });

  it("stalled(橙)在新事件到达后回落为 ok——事件证伪“卡住”", async () => {
    vi.useFakeTimers();
    try {
      const { health, dotTone } = useSessionState();
      const sid = ref<string | null>("uuid-a");
      const chat = useChatSession(sid);
      await flush();
      await chat.sendMessage("q");
      // running 后连续 90s 无事件 → stalled（橙）
      vi.advanceTimersByTime(90_000);
      expect(health["uuid-a"]).toBe("stalled");
      expect(dotTone("uuid-a")).toBe("stalled");
      // 新事件到达 → 证伪卡住，回落 ok，投影回 running（绿）
      emit({ type: "text_delta", delta: "又活了", session_id: "uuid-a" });
      await flush();
      expect(health["uuid-a"]).toBe("ok");
      expect(dotTone("uuid-a")).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("session_dead 置 stopped(灰)并解除忙碌", async () => {
    const { state, dotTone } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "session_dead", reason: "heartbeat_timeout", session_id: "uuid-a" });
    await flush();
    expect(state["uuid-a"]).toBe("stopped");
    expect(dotTone("uuid-a")).toBe("stopped");
    expect(chat.isBusy.value).toBe(false);
  });

  it("并行工具调用的多条 permission_request 排队逐条确认，不互相覆盖（P0 并行权限卡死回归）", async () => {
    const { state } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    // 模型并行调用两个 Read，sidecar 并发发来两条请求
    emit({ type: "permission_request", id: "p1", name: "Read", input: { file_path: "a.java" }, session_id: "uuid-a" });
    emit({ type: "permission_request", id: "p2", name: "Read", input: { file_path: "b.java" }, session_id: "uuid-a" });
    await flush();

    // 弹窗显示队头 p1，p2 排队等待而不是把 p1 覆盖掉
    expect(chat.pendingPermission.value?.id).toBe("p1");
    expect(chat.pendingPermissionCount.value).toBe(2);

    // 确认 p1 后 p2 自动顶上，队列未清空前保持 attention
    await chat.respondPermission("p1", true);
    await flush();
    expect(chat.pendingPermission.value?.id).toBe("p2");
    expect(chat.pendingPermissionCount.value).toBe(1);
    expect(state["uuid-a"]).toBe("attention");

    // 全部确认完才回到 running
    await chat.respondPermission("p2", true);
    await flush();
    expect(chat.pendingPermission.value).toBeNull();
    expect(chat.pendingPermissionCount.value).toBe(0);
    expect(state["uuid-a"]).toBe("running");
  });

  it("permission_cancelled 只移除对应 id，队列里其余请求不受影响", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "permission_request", id: "p1", name: "Read", input: {}, session_id: "uuid-a" });
    emit({ type: "permission_request", id: "p2", name: "Read", input: {}, session_id: "uuid-a" });
    await flush();

    emit({ type: "permission_cancelled", id: "p1", session_id: "uuid-a" });
    await flush();
    expect(chat.pendingPermission.value?.id).toBe("p2");
    expect(chat.pendingPermissionCount.value).toBe(1);
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

  it("text_delta 携带 model 时盖到消息上，一轮内后续事件不重复覆盖", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    emit({ type: "text_delta", delta: "好", model: "kimi-for-coding-highspeed", modelLabel: "sonnet", session_id: "uuid-a" });
    await flush();
    let msg = chat.messages.value[chat.messages.value.length - 1];
    expect(msg.model).toBe("kimi-for-coding-highspeed");
    expect(msg.modelLabel).toBe("sonnet");

    // 后续块事件（不带 model / 或工具事件）不得覆盖已盖的值
    emit({ type: "text_delta", delta: "的", session_id: "uuid-a" });
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: {}, session_id: "uuid-a" });
    await flush();
    msg = chat.messages.value[chat.messages.value.length - 1];
    expect(msg.model).toBe("kimi-for-coding-highspeed");
  });

  it("model_switch_result 落 store 且 seq 单调递增（连续切同一模型也触发 watcher）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    expect(chat.modelSwitchResult.value).toBeNull();

    emit({ type: "model_switch_result", ok: true, model: "opus", display: "Opus", session_id: "uuid-a" });
    await flush();
    expect(chat.modelSwitchResult.value).toMatchObject({ ok: true, model: "opus", display: "Opus", seq: 1 });
    expect(typeof chat.modelSwitchResult.value?.at).toBe("number");

    // 第二次切同一个模型：seq 递增，内容相同也算新回执
    emit({ type: "model_switch_result", ok: true, model: "opus", display: "Opus", session_id: "uuid-a" });
    await flush();
    expect(chat.modelSwitchResult.value?.seq).toBe(2);

    // 失败回执带驳回原因
    emit({ type: "model_switch_result", ok: false, model: "k3", display: "k3", error: "model_not_found", session_id: "uuid-a" });
    await flush();
    expect(chat.modelSwitchResult.value).toMatchObject({ ok: false, model: "k3", display: "k3", error: "model_not_found", seq: 3 });
  });

  it("models_available 不在此层持久化（current 可能是别名，持久化归 ChatPanel 在列校验）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    emit({
      type: "models_available",
      models: [{ value: "sonnet", displayName: "Sonnet" }],
      current: "sonnet",
      session_id: "uuid-a",
    });
    await flush();
    // 回归：sidecar 会把第三方 wire id 解析成 Claude 别名广播，本层不做
    // 在列校验，持久化别名会污染会话记忆（恢复必然失败）——故本层一律不写。
    expect(invokeMock).not.toHaveBeenCalledWith("set_session_model", expect.anything());
    expect(chat.currentModel.value).toBe("sonnet");
  });

  it("setModel 持久化用户选择（用户的选项必然在列表里；停止中的会话靠这次写入记住）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    await chat.setModel("opus");
    expect(invokeMock).toHaveBeenCalledWith("set_session_model", { id: "uuid-a", model: "opus" });
    expect(invokeMock).toHaveBeenCalledWith("set_model", { sessionId: "uuid-a", model: "opus" });
  });

  it("set_model 未投递（无活进程）→ 本地合成 deferred 回执驱动面板提示", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    // Rust 返回 false = 无活进程（invokeMock 缺省 resolve undefined，同为假值）
    await chat.setModel("kimi-for-coding-highspeed");
    expect(chat.modelSwitchResult.value).toMatchObject({
      ok: true,
      model: "kimi-for-coding-highspeed",
      deferred: true,
      seq: 1,
    });
  });

  it("set_model 已投递（进程存活）→ 不合成回执，等 sidecar 坐实事件", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "set_model" ? true : undefined));
    await chat.setModel("opus");
    expect(chat.modelSwitchResult.value).toBeNull();
  });

  it("slash_commands_available 更新会话的命令清单", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    expect(chat.slashCommands.value).toBeNull();

    emit({
      type: "slash_commands_available",
      commands: ["compact", "clear", "review-pr"],
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.slashCommands.value).toEqual(["compact", "clear", "review-pr"]);
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

  it("message_stop 带 usage 时挂到最后一条 assistant 消息", async () => {
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

describe("useChatSession subagent events", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
  });

  it("subagent_start 推入一个 pending 的 subagent 块，subagent_progress/subagent_end 按 id 更新", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("帮我调研一下 XXX");

    emit({
      type: "subagent_start",
      id: "a1",
      agentName: "general-purpose",
      description: "调研 XXX",
      prompt: "调研 XXX 的实现，给出方案与文件清单",
      session_id: "uuid-a",
    });
    await flush();

    type SubagentTestEntry = {
      type: string;
      toolUseId?: string;
      toolName?: string;
      input?: unknown;
      text?: string;
      result?: string;
      isError?: boolean;
    };
    type SubagentTestBlock = {
      agentName?: string;
      description?: string;
      prompt?: string;
      model?: string;
      entries: SubagentTestEntry[];
      isPending: boolean;
      result?: string;
      isError?: boolean;
    };

    let block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as SubagentTestBlock | undefined;
    expect(block).toMatchObject({
      agentName: "general-purpose",
      description: "调研 XXX",
      prompt: "调研 XXX 的实现，给出方案与文件清单",
      isPending: true,
      entries: [],
    });
    expect(block?.result).toBeUndefined();

    emit({
      type: "subagent_progress",
      id: "a1",
      toolUseId: "inner1",
      toolName: "Read",
      input: { file_path: "x.ts" },
      model: "claude-sonnet-5-20260101",
      session_id: "uuid-a",
    });
    await flush();

    block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as SubagentTestBlock | undefined;
    expect(block?.entries).toEqual([
      { type: "tool", toolUseId: "inner1", toolName: "Read", input: { file_path: "x.ts" } },
    ]);
    expect(block?.model).toBe("claude-sonnet-5-20260101");

    // 子代理内部工具的产出按 toolUseId 回填到对应步骤
    emit({
      type: "subagent_tool_result",
      id: "a1",
      toolUseId: "inner1",
      content: "文件内容……",
      is_error: false,
      session_id: "uuid-a",
    });
    await flush();

    block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as SubagentTestBlock | undefined;
    expect(block?.entries).toEqual([
      { type: "tool", toolUseId: "inner1", toolName: "Read", input: { file_path: "x.ts" }, result: "文件内容……", isError: false },
    ]);

    emit({
      type: "subagent_end",
      id: "a1",
      result: "调研结论：……",
      is_error: false,
      session_id: "uuid-a",
    });
    await flush();

    block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as SubagentTestBlock | undefined;
    expect(block).toMatchObject({ isPending: false, result: "调研结论：……", isError: false });
  });

  it("subagent_text_delta/subagent_thinking_delta 逐字累积，类型切换或穿插工具调用时另起一项", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("帮我调研一下 XXX");
    emit({ type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX", session_id: "uuid-a" });

    emit({ type: "subagent_text_delta", id: "a1", delta: "我", session_id: "uuid-a" });
    emit({ type: "subagent_text_delta", id: "a1", delta: "先看看", session_id: "uuid-a" });
    emit({ type: "subagent_thinking_delta", id: "a1", delta: "要不要先读 README", session_id: "uuid-a" });
    emit({ type: "subagent_progress", id: "a1", toolUseId: "inner1", toolName: "Read", input: { file_path: "README.md" }, session_id: "uuid-a" });
    emit({ type: "subagent_text_delta", id: "a1", delta: "看完了", session_id: "uuid-a" });
    await flush();

    const block = chat.messages.value
      .flatMap((m) => m.blocks)
      .find((b) => b.type === "subagent") as
      | { entries: { type: string; text?: string; toolUseId?: string; toolName?: string; input?: unknown }[] }
      | undefined;
    expect(block?.entries).toEqual([
      { type: "text", text: "我先看看" },
      { type: "thinking", text: "要不要先读 README" },
      { type: "tool", toolUseId: "inner1", toolName: "Read", input: { file_path: "README.md" } },
      { type: "text", text: "看完了" },
    ]);
  });

  it("subagent_async_launched 标记后台运行中（保持 pending），后续回放事件正常累积", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("帮我调研 XXX");
    emit({ type: "subagent_start", id: "a1", agentName: "general-purpose", description: "调研 XXX", session_id: "uuid-a" });
    emit({ type: "subagent_async_launched", id: "a1", agentId: "ab99", outputFile: "C:\\x\\ab99.output", session_id: "uuid-a" });
    await flush();

    let block: any = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "subagent");
    expect(block?.isPending).toBe(true);
    expect(block?.asyncLaunched).toEqual({ agentId: "ab99", outputFile: "C:\\x\\ab99.output" });

    // sidecar tail 回放的工具链经现有 subagent_progress handler 累积
    emit({ type: "subagent_progress", id: "a1", toolUseId: "t1", toolName: "Read", input: { file_path: "x.ts" }, model: "glm-5.2", session_id: "uuid-a" });
    await flush();
    block = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "subagent") as any;
    expect(block?.entries).toEqual([{ type: "tool", toolUseId: "t1", toolName: "Read", input: { file_path: "x.ts" } }]);
    expect(block?.model).toBe("glm-5.2");

    // task-notification 收尾
    emit({ type: "subagent_end", id: "a1", result: "结论…", is_error: false, session_id: "uuid-a" });
    await flush();
    block = chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "subagent") as any;
    expect(block?.isPending).toBe(false);
    expect(block?.result).toBe("结论…");
  });

  // 回归：正在进行中的 TODO，会话 stop/退出后顶部不应一直冻结在 in_progress
  // 脉冲——sidecar 进程死后不再发 tasks_update，前端 store.tasks 若不清就会保留
  // 最后一条快照，in_progress 任务永远不完成、一直脉冲，误导用户以为还在跑。
  // 终止路径(session_dead / error fatal:true / stopSession)必须清空 tasks。
  it("session_dead 清空 tasks，in_progress TODO 不残留", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({
      type: "tasks_update",
      tasks: [{ id: "1", subject: "正在做", status: "in_progress", activeForm: "正在做" }],
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.tasks.value).toHaveLength(1);
    expect(chat.tasks.value[0].status).toBe("in_progress");

    emit({ type: "session_dead", session_id: "uuid-a" });
    await flush();
    expect(chat.tasks.value).toEqual([]);
  });

  it("error 致命(fatal:true/缺省)清空 tasks", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({
      type: "tasks_update",
      tasks: [{ id: "1", subject: "做", status: "in_progress" }],
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.tasks.value).toHaveLength(1);

    emit({ type: "error", message: "boom", session_id: "uuid-a" });
    await flush();
    expect(chat.tasks.value).toEqual([]);
  });

  it("error 可恢复(fatal:false)不清空 tasks——进程仍活，任务可能继续更新", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({
      type: "tasks_update",
      tasks: [{ id: "1", subject: "做", status: "in_progress" }],
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.tasks.value).toHaveLength(1);

    emit({ type: "error", message: "boom", fatal: false, session_id: "uuid-a" });
    await flush();
    expect(chat.tasks.value).toHaveLength(1);
  });

  it("stopSession 清空 tasks", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({
      type: "tasks_update",
      tasks: [{ id: "1", subject: "做", status: "in_progress" }],
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.tasks.value).toHaveLength(1);

    await chat.stopSession();
    await flush();
    expect(chat.tasks.value).toEqual([]);
  });
});

describe("useChatSession 会话自动命名", () => {
  beforeEach(async () => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
    // 名字注册表是模块级单例——清空防跨用例污染
    const { useSessionNames } = await import("./useSessionNames");
    for (const k of Object.keys(useSessionNames().names)) delete useSessionNames().names[k];
  });

  it("session_title 事件触发 auto_rename_session，采纳后更新名字注册表", async () => {
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "auto_rename_session" ? true : undefined,
    );

    emit({ type: "session_title", title: "修复登录 Bug", session_id: "uuid-a" });
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("auto_rename_session", {
      id: "uuid-a",
      name: "修复登录 Bug",
    });
    const { useSessionNames } = await import("./useSessionNames");
    expect(useSessionNames().displayName("uuid-a")).toBe("修复登录 Bug");
  });

  it("auto_rename_session 拒绝（用户已手动改名）时不更新注册表", async () => {
    const sid = ref<string | null>("uuid-a");
    useChatSession(sid);
    await flush();
    invokeMock.mockResolvedValue(false);

    emit({ type: "session_title", title: "修复登录 Bug", session_id: "uuid-a" });
    await flush();

    const { useSessionNames } = await import("./useSessionNames");
    // 注册表没有该 id → 退化为 id 前 8 位
    expect(useSessionNames().displayName("uuid-a")).toBe("uuid-a");
  });
});
