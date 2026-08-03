import { describe, it, expect, beforeEach, vi } from "vitest";
import { useBtwSession, __resetBtwForTest } from "./useBtwSession";

// ── Tauri mocks (project style: module-level invokeMock) ──
const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(() => {
  __resetBtwForTest();
  invokeMock.mockClear();
  invokeMock.mockResolvedValue(undefined);
});

describe("useBtwSession routing", () => {
  it("isBtwSid false before start", () => {
    expect(useBtwSession().isBtwSid("any")).toBe(false);
  });

  it("startBtw registers temp id; events route to store", async () => {
    const { startBtw, handleBtwEvent, store } = useBtwSession();
    await startBtw({ tempId: "t1", forkFrom: "main", prompt: "q", cwd: "/r", lightweight: true });
    expect(useBtwSession().isBtwSid("t1")).toBe(true);
    handleBtwEvent({ session_id: "t1", type: "text_delta", delta: "hello" });
    expect(store.value.messages.join("")).toBe("hello");
  });

  it("message_stop assembles conclusion + calls onDone, sets done", async () => {
    const { startBtw, handleBtwEvent, store, setOnDone } = useBtwSession();
    const done = vi.fn();
    setOnDone(done);
    await startBtw({ tempId: "t2", forkFrom: "main", prompt: "why", cwd: "/r", lightweight: false });
    handleBtwEvent({ session_id: "t2", type: "text_delta", delta: "answer" });
    handleBtwEvent({ session_id: "t2", type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null });
    expect(store.value.done).toBe(true);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ actionId: "btw", body: "answer" }));
  });

  it("startBtw replaces existing btw (single instance)", async () => {
    const { startBtw, isBtwSid } = useBtwSession();
    await startBtw({ tempId: "a", forkFrom: "main", prompt: "1", cwd: "/r", lightweight: true });
    await startBtw({ tempId: "b", forkFrom: "main", prompt: "2", cwd: "/r", lightweight: true });
    expect(isBtwSid("a")).toBe(false);
    expect(isBtwSid("b")).toBe(true);
  });

  it("cleanup kills process and clears id", async () => {
    const { startBtw, cleanup, isBtwSid } = useBtwSession();
    await startBtw({ tempId: "c", forkFrom: "main", prompt: "1", cwd: "/r", lightweight: true });
    await cleanup();
    expect(isBtwSid("c")).toBe(false);
  });

  // 支线记忆：同一主会话的下一轮 btw 把此前问答拼进 prompt（2026-08-02）。
  it("next btw prompt carries previous rounds' Q&A of the same owner session", async () => {
    const { startBtw, handleBtwEvent } = useBtwSession();
    await startBtw({ tempId: "h1", forkFrom: "main", prompt: "第一问", cwd: "/r", lightweight: true });
    handleBtwEvent({ session_id: "h1", type: "text_delta", delta: "第一答" });
    handleBtwEvent({ session_id: "h1", type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null });

    await startBtw({ tempId: "h2", forkFrom: "main", prompt: "第二问", cwd: "/r", lightweight: true });
    const sentPrompt = invokeMock.mock.calls[invokeMock.mock.calls.length - 1]?.[1]?.prompt as string;
    expect(sentPrompt).toContain("[本次对话此前的支线问答]");
    expect(sentPrompt).toContain("Q1: 第一问");
    expect(sentPrompt).toContain("A1: 第一答");
    expect(sentPrompt).toContain("[本轮问题]\n第二问");
  });

  it("history is per owner session: another session's btw sees no digest", async () => {
    const { startBtw, handleBtwEvent } = useBtwSession();
    await startBtw({ tempId: "x1", forkFrom: "main-a", prompt: "甲的问", cwd: "/r", lightweight: true });
    handleBtwEvent({ session_id: "x1", type: "text_delta", delta: "甲的答" });
    handleBtwEvent({ session_id: "x1", type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null });

    await startBtw({ tempId: "x2", forkFrom: "main-b", prompt: "乙的问", cwd: "/r", lightweight: true });
    const sentPrompt = invokeMock.mock.calls[invokeMock.mock.calls.length - 1]?.[1]?.prompt as string;
    expect(sentPrompt).toBe("乙的问"); // 无历史 → 原样，不串别的会话的记忆
  });

  it("empty/errored btw leaves no history for the next round", async () => {
    const { startBtw, handleBtwEvent } = useBtwSession();
    await startBtw({ tempId: "z1", forkFrom: "main", prompt: "没答出来", cwd: "/r", lightweight: true });
    handleBtwEvent({ session_id: "z1", type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null }); // 无 delta

    await startBtw({ tempId: "z2", forkFrom: "main", prompt: "再问", cwd: "/r", lightweight: true });
    const sentPrompt = invokeMock.mock.calls[invokeMock.mock.calls.length - 1]?.[1]?.prompt as string;
    expect(sentPrompt).toBe("再问");
  });

  // 「关闭」=最小化:抽屉收起,但 sidecar 继续后台跑。最小化绝不杀进程——
  // 跑完结论照样经 onDone 插进主对话,用户在主对话批注里看到结果。
  it("minimize hides drawer but keeps sidecar alive; conclusion still inserts on done", async () => {
    const { startBtw, minimize, isBtwSid, store, setOnDone, handleBtwEvent } = useBtwSession();
    const done = vi.fn();
    setOnDone(done);
    await startBtw({ tempId: "m1", forkFrom: "main", prompt: "q", cwd: "/r", lightweight: true });
    minimize();
    // 最小化只置标志,进程仍存活(事件仍路由)、抽屉该因此隐藏。
    expect(isBtwSid("m1")).toBe(true);
    expect(store.value.minimized).toBe(true);
    // 后台跑完:onDone 照常把结论插进主对话。
    handleBtwEvent({ session_id: "m1", type: "text_delta", delta: "bg-answer" });
    handleBtwEvent({ session_id: "m1", type: "message_stop", stop_reason: "end_turn", total_cost_usd: null, usage: null });
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ body: "bg-answer" }));
  });

  // 重展抽屉:最小化的逆操作。仅清标志、进程不动。
  it("reopen clears minimized without touching the sidecar", async () => {
    const { startBtw, minimize, reopen, isBtwSid, store } = useBtwSession();
    await startBtw({ tempId: "r1", forkFrom: "main", prompt: "q", cwd: "/r", lightweight: true });
    minimize();
    expect(store.value.minimized).toBe(true);
    reopen();
    expect(store.value.minimized).toBe(false);
    expect(isBtwSid("r1")).toBe(true); // 进程仍存活
  });

  // 出错必须露出来:即便用户已最小化,错误也得把抽屉顶出来,不能在后台静默吞掉。
  it("error while minimized surfaces the drawer (un-minimizes)", async () => {
    const { startBtw, minimize, handleBtwEvent, store } = useBtwSession();
    await startBtw({ tempId: "e1", forkFrom: "main", prompt: "q", cwd: "/r", lightweight: true });
    minimize();
    expect(store.value.minimized).toBe(true);
    handleBtwEvent({ session_id: "e1", type: "error", message: "boom" });
    expect(store.value.status).toBe("error");
    expect(store.value.minimized).toBe(false); // 强制顶出抽屉
    expect(store.value.error).toBe("boom");
  });
});
