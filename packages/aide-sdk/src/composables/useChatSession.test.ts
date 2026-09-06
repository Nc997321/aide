import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, computed, watch, nextTick } from "vue";

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

import { useChatSession, __resetForTest, stopSessionById, disposeSession, __pendingEmptyForTest } from "./useChatSession";
import { useSessionState } from "./useSessionState";
import { useSessionProviders } from "./useSessionProviders";
import { useSessionWorkspaces } from "./useSessionWorkspaces";
import { useSessionNames } from "./useSessionNames";

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: e });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

/**
 * 模拟完整发送闭环：前端发命令 + sidecar 收到后广播 user_message。
 *
 * 方案 C 之后用户气泡只由 `user_message` 事件渲染（发送方不再本地乐观渲染），
 * 测试要复现真实链路就必须补 sidecar 这一跳——否则消息发出去了但界面上没有。
 */
async function sendViaSidecar(
  chat: ReturnType<typeof useChatSession>,
  sessionId: string,
  prompt: string,
  opts?: Parameters<typeof chat.sendMessage>[1],
) {
  await chat.sendMessage(prompt, opts);
  emit({ type: "user_message", text: prompt, session_id: sessionId });
  await flush();
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

  it("tool_result 回填触发响应式——卡片不停在「等待结果…」（挂起表存原始对象回归）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    emit({ type: "tool_use_start", id: "t1", name: "Edit", input: { file_path: "a.ts" }, session_id: "uuid-a" });
    await flush();

    // 组件视角：经 store.messages 响应式链读 block（与模板渲染同一条路径）。
    // 挂起表若存原始对象，回填绕过代理 set 陷阱——值变了但 watch 不触发，
    // 组件只有强制重渲染（折叠重开/切会话）才显示结果。
    const toolResult = computed(
      () =>
        (chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "tool_call") as
          | { result?: string; isPending?: boolean }
          | undefined)?.result,
    );
    const observed: (string | undefined)[] = [];
    watch(toolResult, (v) => observed.push(v));

    emit({ type: "tool_result", id: "t1", content: "ok", is_error: false, session_id: "uuid-a" });
    await flush();

    expect(observed).toContain("ok"); // 关键断言：watcher 必须被触发，而非只有重读才拿到值
    expect(toolResult.value).toBe("ok");
  });

  it("subagent_end 回填触发响应式（同上，子代理挂起表）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    emit({ type: "subagent_start", id: "s1", agentName: "Explore", description: "d", session_id: "uuid-a" });
    await flush();

    const saResult = computed(
      () =>
        (chat.messages.value.flatMap((m) => m.blocks).find((b) => b.type === "subagent") as
          | { result?: string; isPending?: boolean }
          | undefined)?.result,
    );
    const observed: (string | undefined)[] = [];
    watch(saResult, (v) => observed.push(v));

    emit({ type: "subagent_end", id: "s1", result: "调研结论", is_error: false, session_id: "uuid-a" });
    await flush();

    expect(observed).toContain("调研结论");
    expect(saResult.value).toBe("调研结论");
  });

  it("历史会话（UUID id）首次发送时把自身 id 作为 resume 传下去（P0 resume 断裂回归）", async () => {
    const sid = ref<string | null>("0f6d9a2e-1234-4abc-9def-000000000001");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("continue");

    const call = invokeMock.mock.calls.find((c) => c[0] === "send_message");
    expect(call?.[1]).toMatchObject({ resumeId: "0f6d9a2e-1234-4abc-9def-000000000001" });
  });

  it("新会话首发 seed 工作区归属（创建时绑定）：send_message 带 workspaceRoot，session_init 后迁到真实 id", async () => {
    const sid = ref<string | null>(null);
    const chat = useChatSession(sid);
    await flush();

    const ws = { wsKey: "key-a", wsPath: "C:\\proj\\a" };
    const tempId = await chat.sendMessage("first", { workspace: ws });
    expect(tempId).toBeTruthy();

    const { workspaceOf, workspaces } = useSessionWorkspaces();
    // seed 先于 dispatchSend：注册表立即可取，send_message 的 workspaceRoot 不再是 null
    expect(workspaceOf(tempId as string)).toEqual(ws);
    const sendCall = invokeMock.mock.calls.find((c) => c[0] === "send_message");
    expect(sendCall?.[1]).toMatchObject({ sessionId: tempId, workspaceRoot: ws.wsPath });

    // SDK 确认真实 id：归属随 finalizeSession 搬迁，临时条目清除
    emit({ type: "session_init", sdk_session_id: "sdk-uuid-ws", session_id: tempId as string });
    await flush();
    expect(workspaceOf("sdk-uuid-ws")).toEqual(ws);
    expect(workspaces[tempId as string]).toBeUndefined();

    delete workspaces["sdk-uuid-ws"]; // 模块级注册表单例，清掉不污染其他测试
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

    // 真实 id 坐实前到达的压缩状态也必须随同一份 store 迁移，不能留在临时 key。
    emit({ type: "context_compaction", stage: "compacting", session_id: tempId as string });

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
    expect(chat.contextCompaction.value).toMatchObject({ stage: "compacting" });
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

  it("image_input_rollback 解除 busy、落提示消息、文本进 rollbackText 待回填", async () => {
    const { state, health } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("分析这张图", {
      images: [{ data: "not-used", mediaType: "image/png" }],
    });
    expect(chat.isBusy.value).toBe(true);

    emit({ type: "image_input_rollback", text: "分析这张图", session_id: "uuid-a" });
    await flush();

    expect(chat.isBusy.value).toBe(false);
    expect(state["uuid-a"]).toBe("waiting");
    expect(health["uuid-a"]).toBe("warning");
    const lastMessage = chat.messages.value[chat.messages.value.length - 1];
    expect(lastMessage?.blocks).toContainEqual({ type: "text", text: "当前模型不支持图片输入，已移除该消息。文本已放回输入框，可手动重发。" });
    // 文本暂存待 ChatPanel 回填输入框
    expect(chat.rollbackText.value).toBe("分析这张图");

    // 消费后清空，避免重复回填
    chat.consumeRollbackText();
    expect(chat.rollbackText.value).toBe("");
  });

  it("image_input_rollback 无文本（模型 Read 图片）时只提示、不回填输入框", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("看下这个目录");
    expect(chat.isBusy.value).toBe(true);

    emit({ type: "image_input_rollback", text: "", session_id: "uuid-a" });
    await flush();

    expect(chat.isBusy.value).toBe(false);
    expect(chat.rollbackText.value).toBe("");
    const lastMessage = chat.messages.value[chat.messages.value.length - 1];
    expect(lastMessage?.blocks).toContainEqual({ type: "text", text: "当前模型不支持图片输入，已移除图片内容并告知模型，对话继续。" });
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

  it("远程客户端应答：permission_cancelled 撤下弹窗并把 attention 拉回 running", async () => {
    const { state } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "permission_request", id: "p1", name: "Bash", input: {}, session_id: "uuid-a" });
    await flush();
    expect(state["uuid-a"]).toBe("attention");

    // 决策由手机做出：本机不执行 respondPermission，只有 sidecar 回灌的这条事件——
    // 没有它，桌面弹窗永久挂着、会话状态也卡在 attention（远程控制权限残留事故）。
    emit({ type: "permission_cancelled", id: "p1", session_id: "uuid-a" });
    await flush();
    expect(chat.pendingPermission.value).toBeNull();
    expect(state["uuid-a"]).toBe("running");
  });

  it("本地应答后回灌的 permission_cancelled 不再改写状态机（幂等）", async () => {
    const { state } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "permission_request", id: "p1", name: "Bash", input: {}, session_id: "uuid-a" });
    await flush();

    await chat.respondPermission("p1", true); // 本地已乐观出队并置 running
    await flush();
    expect(state["uuid-a"]).toBe("running");

    // sidecar 对本机决策同样广播：弹窗早已出队，不得二次动状态
    emit({ type: "permission_cancelled", id: "p1", session_id: "uuid-a" });
    await flush();
    expect(state["uuid-a"]).toBe("running");
    expect(chat.pendingPermission.value).toBeNull();
  });

  it("interrupt 收尾后迟到的 permission_cancelled 不把 waiting 推回 running", async () => {
    const { state } = useSessionState();
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "permission_request", id: "p1", name: "Bash", input: {}, session_id: "uuid-a" });
    await flush();

    await chat.interrupt(); // finally 清空队列并置 waiting
    emit({ type: "permission_cancelled", id: "p1", session_id: "uuid-a" }); // sidecar cancelAll 迟到
    await flush();
    expect(state["uuid-a"]).toBe("waiting");
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

  it("thinking_delta 逐字追加到同一 thinking block，与 text 块互不并入", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    emit({ type: "thinking_delta", delta: "我", session_id: "uuid-a" });
    emit({ type: "thinking_delta", delta: "在想", session_id: "uuid-a" });
    await flush();
    let blocks = chat.messages.value.flatMap((m) => m.blocks);
    expect(blocks.some((b) => b.type === "thinking" && (b as { text: string }).text === "我在想")).toBe(true);

    // 后续 text 块另起（不并入 thinking）
    emit({ type: "text_delta", delta: "结论", session_id: "uuid-a" });
    await flush();
    blocks = chat.messages.value.flatMap((m) => m.blocks);
    expect(blocks.some((b) => b.type === "text" && (b as { text: string }).text === "结论")).toBe(true);
    expect(blocks.some((b) => b.type === "thinking" && (b as { text: string }).text === "我在想")).toBe(true);
  });

  it("thinking 整块（历史回放）走同一追加逻辑", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");

    emit({ type: "thinking", text: "整块思考内容", session_id: "uuid-a" });
    await flush();
    const blocks = chat.messages.value.flatMap((m) => m.blocks);
    expect(blocks.some((b) => b.type === "thinking" && (b as { text: string }).text === "整块思考内容")).toBe(true);
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

  it("models_available 进程坐实对账：currentModel 坐实到路由层（落盘 IPC 在 identity 层 commitModelFromRuntime 直测）", async () => {
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
    // 路由层断言：models_available 进 case 即坐实 currentModel（bindRuntime+对账落盘
    // 的入口在 events.ts models_available case；落盘 IPC 的分支覆盖在
    // useSessionIdentity.test 的 commitModelFromRuntime 四例直测——对账表分层说明）
    expect(chat.currentModel.value).toBe("sonnet");
  });

  it("setModel 只应用不落盘（落盘移到发送前 settleOnSend，由 ChatPanel 调 L2）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    await chat.setModel("opus");
    // 应用：set_model 派发到存活 sidecar（停止会话返回 false = deferred，见下条用例）
    expect(invokeMock).toHaveBeenCalledWith("set_model", { sessionId: "uuid-a", model: "opus" });
    // 不落盘：下拉切换是草稿，过早落盘会让「切换后不发→重开成切换后」（用户报告 bug）
    expect(invokeMock).not.toHaveBeenCalledWith("set_session_model", expect.anything());
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

  it("context_usage 透传 rawMaxTokens/categories，缺省字段保持 undefined", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    emit({
      type: "context_usage",
      total_tokens: 125500,
      max_tokens: 160000,
      raw_max_tokens: 200000,
      percentage: 62.8,
      categories: [
        null, // 非法元素：wire 守卫剔除，不炸 toLowerCase
        { tokens: 999 }, // 缺 name：剔除
        { name: "Broken", tokens: "nope" }, // tokens 非数值：剔除
        { name: "System Prompt", tokens: 11000 },
        { name: "Tools", tokens: 30700, isDeferred: true },
      ],
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.contextUsage.value).toEqual({
      totalTokens: 125500,
      maxTokens: 160000,
      percentage: 62.8,
      rawMaxTokens: 200000,
      categories: [
        { name: "System Prompt", tokens: 11000 },
        { name: "Tools", tokens: 30700, isDeferred: true },
      ],
    });

    // 旧 sidecar / 降级：不带扩展字段也不炸，环形照常
    emit({
      type: "context_usage",
      total_tokens: 10,
      max_tokens: 20,
      percentage: 50,
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.contextUsage.value).toEqual({
      totalTokens: 10,
      maxTokens: 20,
      percentage: 50,
      rawMaxTokens: undefined,
      categories: undefined,
    });
  });

  it("model_switch_confirm 建成本确认状态（wire 字段映射 + 非法枚举兜底）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    expect(chat.modelSwitchConfirm.value).toBeNull();

    emit({
      type: "model_switch_confirm",
      confirm_id: "switch-confirm-x1",
      from_model: "kimi",
      to_model: "fable-resolved:full-id",
      source: "sdk",
      context_tokens: 123456,
      prompt_cache_warm: true,
      estimated_cache_write_usd: 1.25,
      cache_ttl: "5m",
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.modelSwitchConfirm.value).toEqual({
      confirmId: "switch-confirm-x1",
      fromModel: "kimi",
      toModel: "fable-resolved:full-id",
      source: "sdk",
      contextTokens: 123456,
      promptCacheWarm: true,
      estimatedCacheWriteUsd: 1.25,
      cacheTtl: "5m",
    });

    // 非法 source/cache_ttl（wire 脏值）→ 收窄兜底，不把 string 塞进字面量联合
    emit({
      type: "model_switch_confirm",
      confirm_id: "switch-confirm-x2",
      from_model: "kimi",
      to_model: "fable-x",
      source: "hijack",
      context_tokens: 80_000,
      prompt_cache_warm: false,
      estimated_cache_write_usd: 0,
      cache_ttl: "bogus",
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.modelSwitchConfirm.value?.source).toBe("sdk");
    expect(chat.modelSwitchConfirm.value?.cacheTtl).toBe("5m");

    // "1h" 合法臂：原值接受（不经兜底改写）
    emit({
      type: "model_switch_confirm",
      confirm_id: "switch-confirm-x3",
      from_model: "kimi",
      to_model: "fable-x",
      source: "sdk",
      context_tokens: 80_000,
      prompt_cache_warm: true,
      estimated_cache_write_usd: 0,
      cache_ttl: "1h",
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.modelSwitchConfirm.value?.cacheTtl).toBe("1h");
  });

  it("model_committed：清确认弹窗 + currentModel 坐实 + 落盘 requested_model（事件驱动落盘主链路）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    emit({
      type: "model_switch_confirm",
      confirm_id: "c1", from_model: "kimi", to_model: "fable", source: "sdk",
      context_tokens: 10, prompt_cache_warm: true, estimated_cache_write_usd: 0, cache_ttl: "5m",
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.modelSwitchConfirm.value).not.toBeNull();

    // 切换真实完成：弹窗清 + currentModel 同步（requested 命名空间）+ 落盘
    emit({
      type: "model_committed",
      from_model: "kimi", to_model: "fable-resolved:full", requested_model: "fable", source: "sdk",
      session_id: "uuid-a",
    });
    await flush();
    invokeMock.mockClear();
    // 同值重放：幂等（不重复落盘）
    emit({
      type: "model_committed",
      from_model: "kimi", to_model: "fable-resolved:full", requested_model: "fable", source: "sdk",
      session_id: "uuid-a",
    });
    await flush();
    const modelCalls = invokeMock.mock.calls.filter((c) => c[0] === "set_session_model");
    expect(modelCalls.length).toBe(0); // 首坐实已落盘；同值重放被幂等跳过（不再写盘）
    expect(chat.currentModel.value).toBe("fable"); // requested 命名空间坐实
    expect(chat.modelSwitchConfirm.value).toBeNull(); // 切换完成终结弹窗

    // requested=null（CLI 内部 auto/resume 切换）：不碰 currentModel 账面（resolved
    // 全名与下拉别名跨命名空间），仅确认弹窗照常清（终态语义）
    emit({
      type: "model_committed",
      from_model: "fable", to_model: "auto-resolved:full", requested_model: null, source: "auto",
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.currentModel.value).toBe("fable"); // 不被 resolved 全名污染
    expect(chat.modelSwitchConfirm.value).toBeNull();
  });

  it("model_switch_result 终态清挂起弹窗（超时 deny 前端黑洞回归）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    emit({
      type: "model_switch_confirm",
      confirm_id: "c-timeout", from_model: "kimi", to_model: "fable", source: "sdk",
      context_tokens: 80_000, prompt_cache_warm: true, estimated_cache_write_usd: 0, cache_ttl: "5m",
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.modelSwitchConfirm.value).not.toBeNull();

    // sidecar 10s 超时自动 deny → setModel reject → ok:false 终态回执
    emit({
      type: "model_switch_result",
      ok: false, model: "fable", display: "Fable", error: "model_switch_timeout",
      session_id: "uuid-a",
    });
    await flush();
    // 黑洞回归：弹窗被终结（不再滞留），否则后到的 allow 被静默吞掉
    expect(chat.modelSwitchConfirm.value).toBeNull();
  });

  it("context_compaction 只维护会话瞬态状态，失败会保留到下一轮", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    expect(chat.contextCompaction.value).toBeNull();
    await sendViaSidecar(chat, "uuid-a", "压缩上下文");

    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    await flush();
    const startedAt = chat.contextCompaction.value?.startedAt;
    expect(chat.contextCompaction.value).toMatchObject({ stage: "compacting" });
    expect(typeof startedAt).toBe("number");
    // 状态条不作为 assistant 消息写进消息流。
    expect(chat.messages.value).toHaveLength(1);
    expect(chat.messages.value[0]?.role).toBe("user");

    // 重复的进行中事件不应重置已用时长。
    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    await flush();
    expect(chat.contextCompaction.value?.startedAt).toBe(startedAt);

    emit({
      type: "context_compaction",
      stage: "failed",
      error: "压缩服务暂时不可用",
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.contextCompaction.value).toMatchObject({
      stage: "failed",
      error: "压缩服务暂时不可用",
    });

    // 失败不能被紧随其后的 message_stop 一闪而过；下一次真正发起的新轮次才撤掉它。
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
    await flush();
    expect(chat.contextCompaction.value).toMatchObject({ stage: "failed" });

    await chat.sendMessage("继续");
    expect(chat.contextCompaction.value).toBeNull();
  });

  it("context_compaction 的成功、错误、会话死亡和中断都会撤掉状态条", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    await chat.sendMessage("q");
    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    emit({ type: "context_compaction", stage: "completed", session_id: "uuid-a" });
    await flush();
    expect(chat.contextCompaction.value).toBeNull();

    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    emit({ type: "error", message: "boom", fatal: false, session_id: "uuid-a" });
    await flush();
    expect(chat.contextCompaction.value).toBeNull();

    await chat.sendMessage("q2");
    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    emit({ type: "session_dead", reason: "exit", session_id: "uuid-a" });
    await flush();
    expect(chat.contextCompaction.value).toBeNull();

    await chat.sendMessage("q3");
    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    await flush();
    await chat.interrupt();
    expect(chat.contextCompaction.value).toBeNull();
  });

  it("忽略闲置会话迟到的 context_compaction 事件", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    await flush();
    expect(chat.contextCompaction.value).toBeNull();

    await chat.sendMessage("q");
    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    emit({ type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null, session_id: "uuid-a" });
    emit({ type: "context_compaction", stage: "failed", error: "迟到事件", session_id: "uuid-a" });
    await flush();
    expect(chat.contextCompaction.value).toBeNull();
  });

  it("忙碌时排队的新消息不会提前清掉正在压缩的状态条", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    await chat.sendMessage("q");
    emit({ type: "context_compaction", stage: "compacting", session_id: "uuid-a" });
    await flush();
    await chat.sendMessage("排队的下一条");

    expect(chat.contextCompaction.value).toMatchObject({ stage: "compacting" });
  });

  it("排队消息在工具跑完（jump_promoted）前不渲染成对话气泡，只显示待发出提示条", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    // 第一条消息：会话进入忙碌（sidecar 广播 user_message 后 isBusy=true）
    await sendViaSidecar(chat, "uuid-a", "q");
    emit({ type: "text_delta", delta: "回复中", session_id: "uuid-a" });
    await flush();
    expect(chat.isBusy.value).toBe(true);

    // 工具还在跑（isBusy 仍 true）时排队下一条
    await chat.sendMessage("排队消息");

    // 排队消息不应立即渲染成对话气泡——只该出现在"待发出"提示条里
    const userMsgs = chat.messages.value.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(1);
    expect(chat.pendingJumps.value.length).toBe(1);
    expect(chat.pendingJumps.value[0].text).toBe("排队消息");

    // 工具跑完，sidecar 到达安全边界接入排队消息：先广播气泡，再发 promoted 收尾
    emit({ type: "user_message", text: "排队消息", session_id: "uuid-a" });
    emit({ type: "jump_promoted", session_id: "uuid-a" });
    await flush();

    // 此时排队消息才落成对话气泡，提示条清空
    const userMsgsAfter = chat.messages.value.filter((m) => m.role === "user");
    expect(userMsgsAfter.length).toBe(2);
    const lastUser = userMsgsAfter[1];
    expect(
      lastUser.blocks.some((b) => b.type === "text" && (b as { text: string }).text === "排队消息"),
    ).toBe(true);
    expect(chat.pendingJumps.value.length).toBe(0);
  });

  it("多条排队逐条暂存，jump_queued 不重复入队，jump_promoted 一次全部 flush", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await sendViaSidecar(chat, "uuid-a", "q");
    emit({ type: "text_delta", delta: "回复中", session_id: "uuid-a" });
    await flush();

    // 工具持续在跑：连续排队两条
    await chat.sendMessage("排队1");
    await chat.sendMessage("排队2");
    // 每条暂存一次，提示条 2 项；用户气泡仍只有第一条 q
    expect(chat.pendingJumps.value.length).toBe(2);
    expect(chat.pendingJumps.value.map((j) => j.text)).toEqual(["排队1", "排队2"]);
    expect(chat.messages.value.filter((m) => m.role === "user").length).toBe(1);

    // sidecar 逐条回 jump_queued 确认——不能让提示条重复成 4 项
    emit({ type: "jump_queued", prompt: "排队1", session_id: "uuid-a" });
    emit({ type: "jump_queued", prompt: "排队2", session_id: "uuid-a" });
    await flush();
    expect(chat.pendingJumps.value.length).toBe(2);

    // 工具跑完：sidecar 逐条广播 user_message 成气泡，再一次 jump_promoted 收尾
    emit({ type: "user_message", text: "排队1", session_id: "uuid-a" });
    emit({ type: "user_message", text: "排队2", session_id: "uuid-a" });
    emit({ type: "jump_promoted", session_id: "uuid-a" });
    await flush();
    const userMsgs = chat.messages.value.filter((m) => m.role === "user");
    expect(userMsgs.length).toBe(3);
    const texts = userMsgs.map(
      (m) => (m.blocks.find((b) => b.type === "text") as { text: string } | undefined)?.text,
    );
    expect(texts).toEqual(["q", "排队1", "排队2"]);
    expect(chat.pendingJumps.value.length).toBe(0);
  });

  it("远程客户端发的消息只带 user_message 事件 → 桌面端照样出气泡并进入忙碌", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    // 关键场景：手机发的消息。桌面端从未调过 sendMessage、只收到事件——这正是
    // 方案 C 要修的病例（以前只有发起方能看见自己提的问题）。
    emit({ type: "user_message", text: "手机上问的问题", session_id: "uuid-a" });
    await flush();

    const userMsgs = chat.messages.value.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].blocks).toEqual([{ type: "text", text: "手机上问的问题" }]);
    // 忙碌态必须跟上：远程消息不经过本地 prepareSend，靠事件处理里补
    expect(chat.isBusy.value).toBe(true);
  });

  it("user_message 带 display：@引用渲染成独立卡片，不与正文混成一坨", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    emit({
      type: "user_message",
      text: "看看这个文件",
      session_id: "uuid-a",
      display: [
        { type: "text", text: "看看这个文件" },
        { type: "mention", path: "src/a.ts", content: "const a = 1;" },
      ],
    });
    await flush();

    const msg = chat.messages.value.find((m) => m.role === "user");
    // 两块：正文 + 引用卡片。合并成一块就说明 display 没被消费（退化成纯文本）
    expect(msg?.blocks).toHaveLength(2);
    const tool = msg?.blocks.find((b) => b.type === "tool_call");
    expect(tool && "input" in tool ? tool.input : null).toEqual({ file_path: "src/a.ts" });
    expect(tool && "result" in tool ? tool.result : "").toBe("const a = 1;");
  });

  it("user_message 带 display：动作胶囊渲染成 action 块（/compact 之类）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    emit({
      type: "user_message",
      text: "/compact",
      session_id: "uuid-a",
      display: [{ type: "action", actionId: "compact", label: "压缩上下文", icon: "zip" }],
    });
    await flush();

    const msg = chat.messages.value.find((m) => m.role === "user");
    expect(msg?.blocks).toEqual([
      { type: "action", actionId: "compact", label: "压缩上下文", icon: "zip" },
    ]);
  });

  it("user_message 无 display（鸿蒙 v1）→ 降级成纯文本气泡，不丢消息", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();

    // 老客户端不认识 display 字段：接收端不能因为协议差就整条丢掉
    emit({ type: "user_message", text: "纯文本消息", session_id: "uuid-a" });
    await flush();

    const msg = chat.messages.value.find((m) => m.role === "user");
    expect(msg?.blocks).toEqual([{ type: "text", text: "纯文本消息" }]);
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

  it("stopSessionById 清空 tasks（按 sid 停止，不依赖激活 tab）", async () => {
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

    await stopSessionById("uuid-a");
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

  it("已定名会话的 session_title 触发 auto_rename_session，采纳后更新名字注册表", async () => {
    const sid = ref<string | null>(null);
    const chat = useChatSession(sid);
    await flush();
    const tempId = (await chat.sendMessage("first")) as string;
    emit({ type: "session_init", sdk_session_id: "uuid-a", session_id: tempId });
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
    const sid = ref<string | null>(null);
    const chat = useChatSession(sid);
    await flush();
    const tempId = (await chat.sendMessage("first")) as string;
    emit({ type: "session_init", sdk_session_id: "uuid-a", session_id: tempId });
    await flush();

    invokeMock.mockResolvedValue(false);
    emit({ type: "session_title", title: "修复登录 Bug", session_id: "uuid-a" });
    await flush();

    const { useSessionNames } = await import("./useSessionNames");
    // 注册表没有该 id → 退化为 id 前 8 位
    expect(useSessionNames().displayName("uuid-a")).toBe("uuid-a");
  });

  it("旁观端收到别的客户端发起的会话标题：只暂存不落盘", async () => {
    // PWA 发起新会话时桌面端也会收到同一条 session_title（sid = 对方的临时
    // id，本端既非 pending 也还没定名）。落盘由发起方负责——本端若抢写，
    // 一是给对方的 tempId 建孤儿元数据，二是随后用 id 前 8 位覆盖对方写好的
    // 名字。两端都暂存、各自 finalize 时取用，写入的名字一致。
    const sid = ref<string | null>("temp-from-pwa");
    useChatSession(sid);
    await flush();

    emit({ type: "session_title", title: "修复登录 Bug", session_id: "temp-from-pwa" });
    await flush();

    expect(
      invokeMock.mock.calls.some((c) => c[0] === "auto_rename_session"),
    ).toBe(false);
    const { useSessionNames } = await import("./useSessionNames");
    expect(useSessionNames().takePendingTitle("temp-from-pwa")).toBe("修复登录 Bug");
  });

  it("未定名会话的 session_title 只暂存不落盘，定名时随 finalize 迁到真实 id", async () => {
    // 回归：session_title 早于 session_init 到达。此前直接 auto_rename，
    // 标题写进 <tempId>.json，随后 create_session(realId, 默认名) 建真文件
    // → 标题成孤儿、名字恒为「新会话 HH:MM:SS」。
    const sid = ref<string | null>(null);
    const chat = useChatSession(sid);
    await flush();

    const tempId = (await chat.sendMessage("帮我修登录页 bug")) as string;
    emit({ type: "session_title", title: "帮我修登录页", session_id: tempId });
    await flush();

    expect(
      invokeMock.mock.calls.some((c) => c[0] === "auto_rename_session"),
    ).toBe(false);

    const { useSessionNames } = await import("./useSessionNames");
    // 暂存可取出，且取走即弃（落盘方只能用一次，不会覆盖用户后改的名字）
    expect(useSessionNames().takePendingTitle(tempId)).toBe("帮我修登录页");
    expect(useSessionNames().takePendingTitle(tempId)).toBeUndefined();

    // 定名（session_init）→ 标题迁到真实 id，落盘方据此写最终名
    useSessionNames().setPendingTitle(tempId, "帮我修登录页");
    emit({ type: "session_init", sdk_session_id: "sdk-uuid-title", session_id: tempId });
    await flush();
    expect(useSessionNames().takePendingTitle("sdk-uuid-title")).toBe("帮我修登录页");
    expect(useSessionNames().takePendingTitle(tempId)).toBeUndefined();
  });

  it("send_message 失败 → console.warn + 忙态复位（fire-and-forget 兜底不静默）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("sidecar spawn boom"));

    await chat.sendMessage("hello");
    await flush();
    await flush();

    expect(warnSpy).toHaveBeenCalledWith(
      "send_message failed:",
      expect.any(Error),
    );
    // 状态复位：不残留 busy（否则 UI 永久转圈）
    expect(chat.isBusy.value).toBe(false);
    const { state } = useSessionState();
    expect(state["uuid-a"]).toBe("stopped");
    warnSpy.mockRestore();
  });

  it("sendMessage: 会话已有 provider 绑定（restoreBinding 恢复的自身身份）→ 不被全局 active 覆盖", async () => {
    const sid = ref<string | null>("uuid-b");
    const chat = useChatSession(sid);
    await flush();
    const { setProvider, providerOf } = useSessionProviders();
    setProvider("uuid-b", "kimi-provider"); // 重开会话 restoreBinding 已恢复的身份

    await chat.sendMessage("hello");

    expect(providerOf("uuid-b")).toBe("kimi-provider"); // 绑定未被盖写
    // 身份透传给 Rust：send_message 的 provider 参数 = 会话自身绑定
    const sendCall = invokeMock.mock.calls.find(([cmd]) => cmd === "send_message");
    expect(sendCall?.[1]).toMatchObject({ sessionId: "uuid-b", provider: "kimi-provider" });
    // 没有盖戳动作 → 不发生 set_session_provider 写盘（原 watcher 已删）
    const setProviderCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "set_session_provider");
    expect(setProviderCalls).toHaveLength(0);
  });

  it("sendMessage: 无绑定的停止会话 → send_message provider=null（盖戳在 L2，Rust 回落全局 active）", async () => {
    const sid = ref<string | null>("uuid-c");
    const chat = useChatSession(sid);
    await flush();

    await chat.sendMessage("hello");

    // useChatSession 不再盖戳（盖戳在 L2 settleOnSend/resolve，由 ChatPanel 调）；
    // 无绑定 → send_message provider=null，Rust 侧回落全局 active。
    const sendCall = invokeMock.mock.calls.find(([cmd]) => cmd === "send_message");
    expect(sendCall?.[1]).toMatchObject({ sessionId: "uuid-c", provider: null });
  });

  it("setEffort 持久化失败（set_session_effort reject）→ console.warn 降级", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "set_session_effort") throw new Error("disk full");
      return undefined;
    });

    await chat.setEffort("high");
    await flush();

    expect(warnSpy).toHaveBeenCalledWith(
      "[chat] persist effort failed:",
      "uuid-a",
      "high",
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

describe("生命周期收口 disposeSession", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
    for (const k of Object.keys(useSessionNames().names)) delete useSessionNames().names[k];
    const { workspaces } = useSessionWorkspaces();
    for (const k of Object.keys(workspaces)) delete workspaces[k];
  });

  it("disposeSession 删 store + per-sid 字典 + 标记，拦截后续事件不复活，幂等不抛", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "text_delta", delta: "回复", session_id: "uuid-a" });
    await flush();
    expect(chat.messages.value.length).toBeGreaterThan(0);
    useSessionNames().setName("uuid-a", "会话A");
    const { state } = useSessionState();
    expect(state["uuid-a"]).toBe("running");

    disposeSession("uuid-a");

    // store 删 + per-sid 字典清
    expect(state["uuid-a"]).toBeUndefined();
    expect(useSessionNames().names["uuid-a"]).toBeUndefined();
    expect(useSessionWorkspaces().workspaces["uuid-a"]).toBeUndefined();
    // current computed 守卫 → messages 空
    expect(chat.messages.value).toEqual([]);
    // 延迟事件被 handleChatEvent 守卫拦截，不重建 store
    emit({ type: "text_delta", delta: "延迟到达", session_id: "uuid-a" });
    await flush();
    expect(chat.messages.value).toEqual([]);
    // 幂等不抛
    expect(() => disposeSession("uuid-a")).not.toThrow();
  });

  it("dispose 后 session_dead 不复活 store、不写僵尸消息", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    disposeSession("uuid-a");
    emit({ type: "session_dead", reason: "exit", session_id: "uuid-a" });
    await flush();
    expect(chat.messages.value).toEqual([]);
    expect(useSessionState().state["uuid-a"]).toBeUndefined();
  });

  it("hydrate 解除标记：重开会话恢复事件流", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    disposeSession("uuid-a");
    expect(chat.messages.value).toEqual([]);
    // 重开：sid 先置空再置回，watcher→hydrate 清除销毁标记并重建 store
    sid.value = null;
    await flush();
    sid.value = "uuid-a";
    await flush();
    // hydrate 后事件正常入 store
    emit({ type: "text_delta", delta: "重开回复", session_id: "uuid-a" });
    await flush();
    const texts = chat.messages.value.flatMap((m) => m.blocks).filter((b) => b.type === "text");
    expect(texts.some((b) => (b as { text: string }).text === "重开回复")).toBe(true);
  });

  it("pending 会话关闭：迟到 session_init 不 finalize 落盘", async () => {
    const sid = ref<string | null>(null);
    const chat = useChatSession(sid);
    const created = vi.fn();
    chat.onSessionCreated(created);
    await flush();
    const tempId = await chat.sendMessage("first");
    expect(tempId).toBeTruthy();
    // 关闭 pending 会话：清 pendingSids + 标记 disposed
    disposeSession(tempId as string);
    // 迟到的 session_init 被拦截，不触发 finalize（created 不被调用、不迁移到 realId）
    emit({ type: "session_init", sdk_session_id: "sdk-real-1", session_id: tempId as string });
    await flush();
    expect(created).not.toHaveBeenCalled();
    expect(useSessionWorkspaces().workspaceOf("sdk-real-1")).toBeNull();
    expect(useSessionState().state[tempId as string]).toBeUndefined();
  });

  it("send_message 在途 reject 时已关闭会话不复活 store", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 手动控制 send_message 的 reject 时机：其他 invoke 正常 resolve
    let rejectSend: (e: unknown) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "send_message") {
        return new Promise((_resolve, reject) => {
          rejectSend = reject;
        });
      }
      return undefined;
    });
    await chat.sendMessage("q"); // send_message 进入在途（pending，sendQueued 不 await）
    disposeSession("uuid-a"); // 关闭会话
    rejectSend(new Error("boom")); // 现在才 reject → .catch 守卫拦截
    await flush();
    await flush();
    expect(useSessionState().state["uuid-a"]).toBeUndefined();
    expect(chat.messages.value).toEqual([]);
    warnSpy.mockRestore();
  });

  it("bgDock 自动撤条定时器在会话关闭后不复活 store", async () => {
    vi.useFakeTimers();
    try {
      const sid = ref<string | null>("uuid-a");
      const chat = useChatSession(sid);
      await flush();
      await chat.sendMessage("q");
      // 后台任务结束 → 排 4s 自动撤条定时器
      emit({ type: "bg_task_started", id: "bg1", command: "sleep 1", session_id: "uuid-a" });
      emit({ type: "bg_task_ended", id: "bg1", status: "completed", summary: "done", session_id: "uuid-a" });
      await flush();
      disposeSession("uuid-a"); // clearBgDockAutoHide 清定时器
      // 推进定时器：已清，回调不执行；即便执行也有 disposedSids 守卫兜底
      vi.advanceTimersByTime(5000);
      expect(useSessionState().state["uuid-a"]).toBeUndefined();
      expect(chat.messages.value).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposeSession 后再 sendMessage 不派发、不重建 store（sendMessage 守卫）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    disposeSession("uuid-a");
    invokeMock.mockClear();
    await chat.sendMessage("again");
    await flush();
    // sendMessage 守卫 1（ensureGlobalListener 后）拦截：不调 send_message、不重建 store
    expect(invokeMock).not.toHaveBeenCalledWith("send_message", expect.anything());
    expect(useSessionState().state["uuid-a"]).toBeUndefined();
    expect(chat.messages.value).toEqual([]);
  });

  it("disposeSession 后 stopSessionById 守卫：不再 invoke stop_chat_session（防误调复活）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    disposeSession("uuid-a");
    invokeMock.mockClear();
    await stopSessionById("uuid-a"); // 守卫拦截，不应 invoke
    expect(invokeMock).not.toHaveBeenCalledWith("stop_chat_session", expect.anything());
    expect(useSessionState().state["uuid-a"]).toBeUndefined();
  });
});

describe("回填注册表（P0-2：Map O(1) 查找替代 flatMap）", () => {
  beforeEach(() => {
    __resetForTest();
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    const { state, removeSessionState } = useSessionState();
    for (const k of Object.keys(state)) removeSessionState(k);
    for (const k of Object.keys(useSessionNames().names)) delete useSessionNames().names[k];
    const { workspaces } = useSessionWorkspaces();
    for (const k of Object.keys(workspaces)) delete workspaces[k];
  });

  it("finalize 迁移回填注册表：tempId 注册的 tool_use 与 subagent 在 realId 下仍能回填", async () => {
    const sid = ref<string | null>(null);
    const chat = useChatSession(sid);
    await flush();
    const tempId = await chat.sendMessage("q");
    // 模拟 race：session_init 之前收到 tool_use_start + subagent_start（注册在 tempId 下）
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: { command: "ls" }, session_id: tempId as string });
    emit({ type: "subagent_start", id: "a1", agentName: "general-purpose", description: "d", session_id: tempId as string });
    await flush();
    expect(__pendingEmptyForTest(tempId as string)).toBe(false);
    // session_init finalize：两张注册表从 tempId 迁到 realId
    emit({ type: "session_init", sdk_session_id: "sdk-real-x", session_id: tempId as string });
    await flush();
    expect(__pendingEmptyForTest(tempId as string)).toBe(true); // tempId 已迁走
    expect(__pendingEmptyForTest("sdk-real-x")).toBe(false); // realId 接到
    // tool_result + subagent_end 经 alias(tempId)路由到 realId，lookup 命中迁移后的条目
    emit({ type: "tool_result", id: "t1", content: "ok", is_error: false, session_id: tempId as string });
    emit({ type: "subagent_end", id: "a1", result: "done", is_error: false, session_id: tempId as string });
    await flush();
    sid.value = "sdk-real-x";
    await flush();
    const blocks = chat.messages.value.flatMap((m) => m.blocks);
    const tool = blocks.find((b) => b.type === "tool_call") as { result?: string; isPending?: boolean } | undefined;
    expect(tool?.result).toBe("ok");
    expect(tool?.isPending).toBe(false);
    const sa = blocks.find((b) => b.type === "subagent") as { result?: string; isPending?: boolean } | undefined;
    expect(sa?.result).toBe("done");
    expect(sa?.isPending).toBe(false);
  });

  it("disposeSession 清空该 sid 的回填注册表（无残留）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: {}, session_id: "uuid-a" });
    emit({ type: "subagent_start", id: "a1", agentName: "general-purpose", description: "d", session_id: "uuid-a" });
    await flush();
    expect(__pendingEmptyForTest("uuid-a")).toBe(false);
    disposeSession("uuid-a");
    expect(__pendingEmptyForTest("uuid-a")).toBe(true);
  });

  it("同会话多个工具调用都能回填（register 第二次走已存在的内层 Map）", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    await chat.sendMessage("q");
    emit({ type: "tool_use_start", id: "t1", name: "Bash", input: {}, session_id: "uuid-a" });
    emit({ type: "tool_use_start", id: "t2", name: "Read", input: {}, session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t1", content: "r1", is_error: false, session_id: "uuid-a" });
    emit({ type: "tool_result", id: "t2", content: "r2", is_error: false, session_id: "uuid-a" });
    await flush();
    const tools = chat.messages.value.flatMap((m) => m.blocks).filter((b) => b.type === "tool_call") as
      | { id: string; result?: string; isPending?: boolean }
      | undefined;
    const t1 = tools.find((t) => t?.id === "t1");
    const t2 = tools.find((t) => t?.id === "t2");
    expect(t1?.result).toBe("r1");
    expect(t2?.result).toBe("r2");
    expect(__pendingEmptyForTest("uuid-a")).toBe(true); // 都已注销
  });
});
