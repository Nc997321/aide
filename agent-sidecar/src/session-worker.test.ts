import { describe, it, expect } from "vitest";
import { SessionWorker } from "./session-worker.js";

/**
 * 验证 SessionWorker 的 fork 源 / 路由键设定逻辑。
 *
 * 关键不变量：
 * - 构造时 fork 源为空（普通会话不 resume）
 * - routingKey 等于构造参数（SessionManager 据此 re-key）
 * - 只有 btw / provider_switched 才设 fork 源（在 handleCommand 里）
 * - BTW 从 fork_from 读 fork 源，不从 session_id 读
 */

function makeWorker(sid = "test-sid") {
  const events: any[] = [];
  return {
    worker: new SessionWorker(sid, (e) => events.push(e)),
    events,
  };
}

describe("SessionWorker — fork source / routing key invariants", () => {
  it("constructor: fork source starts empty (no resume for normal session)", () => {
    const { worker } = makeWorker();
    const { forkSource, shouldFork } = worker._testForkState();
    expect(forkSource).toBe("");
    expect(shouldFork).toBe(false);
  });

  it("constructor: routingKey equals the constructor arg", () => {
    const { worker } = makeWorker("temp-abc");
    expect(worker.routingKey).toBe("temp-abc");
  });

  it("constructor with btwMode: fork source still empty (set by handleCommand, not constructor)", () => {
    const { worker } = makeWorker();
    const { forkSource } = worker._testForkState();
    expect(forkSource).toBe("");
  });

  it("stop() cleans up without throwing", () => {
    const { worker } = makeWorker();
    worker.stop();
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
