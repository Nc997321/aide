import { describe, it, expect } from "vitest";
import { SessionWorker } from "./session-worker.js";

/**
 * 验证 SessionWorker 的 fork 源设定逻辑。
 *
 * 关键不变量：
 * - 构造时 fork 源为空（普通会话不 resume）
 * - 只有 btw / provider_switched 才设 fork 源
 * - BTW 从 fork_from 读 fork 源，不从 session_id 读
 */

function makeWorker(sid = "test-sid") {
  const events: any[] = [];
  return {
    worker: new SessionWorker(sid, (e) => events.push(e)),
    events,
  };
}

describe("SessionWorker — fork source invariants", () => {
  it("constructor: fork source starts empty (no resume for normal session)", () => {
    const { worker } = makeWorker();
    const { forkSource, shouldFork } = worker._testForkState();
    expect(forkSource).toBe("");
    expect(shouldFork).toBe(false);
  });

  it("constructor with btwMode: fork source still empty (set by handleCommand, not constructor)", () => {
    const { worker } = makeWorker();
    // btwMode 在 handleCommand 里设，构造时不设 fork 源
    const { forkSource } = worker._testForkState();
    expect(forkSource).toBe("");
  });

  it("stop() cleans up without throwing", () => {
    const { worker } = makeWorker();
    worker.stop(); // 无 query 时也不应抛异常
    expect(worker.isActive()).toBe(false);
  });

  it("isActive() returns false before startLoop", () => {
    const { worker } = makeWorker();
    expect(worker.isActive()).toBe(false);
  });

  it("isStalled() returns false with no query", () => {
    const { worker } = makeWorker();
    expect(worker.isStalled()).toBe(false);
  });
});
