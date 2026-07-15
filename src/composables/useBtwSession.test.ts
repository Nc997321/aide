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
});
