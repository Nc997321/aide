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
});
