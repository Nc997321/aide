// useKbDocLock 的时序测试：重点在心跳续租、失锁判定与生命周期清理。
// API 全部 mock（见 KbLockApi 注释——这个状态机刻意不依赖 kbClient）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKbDocLock, type KbLockApi } from "./useKbDocLock";

function mockApi() {
  return {
    acquire: vi.fn<(id: string) => Promise<{ held: boolean; holder: { displayName: string } | null }>>(),
    heartbeat: vi.fn<(id: string) => Promise<{ renewed: boolean }>>(),
    release: vi.fn<(id: string) => Promise<{ released: boolean }>>(),
  };
}

const HELD = { held: true, holder: null };

describe("useKbDocLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enter 拿到锁进入 held，并按间隔心跳续租", async () => {
    const api = mockApi();
    api.acquire.mockResolvedValue(HELD);
    api.heartbeat.mockResolvedValue({ renewed: true });
    const lock = useKbDocLock(api);

    await expect(lock.enter("doc-1")).resolves.toBe(true);
    expect(lock.held.value).toBe(true);

    // 默认 30s 间隔：29s 不跳，30s 跳一次
    await vi.advanceTimersByTimeAsync(29_000);
    expect(api.heartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.heartbeat).toHaveBeenCalledWith("doc-1");
    // 续租成功保持 held
    expect(lock.held.value).toBe(true);

    lock.dispose();
  });

  it("enter 被别人持有时进入 conflict，且不占锁（exit 不会误释放）", async () => {
    const api = mockApi();
    api.acquire.mockResolvedValue({
      held: false,
      holder: { displayName: "张三" },
    });
    const lock = useKbDocLock(api);

    await expect(lock.enter("doc-1")).resolves.toBe(false);
    expect(lock.state.value.phase).toBe("conflict");
    expect(lock.state.value.holderName).toBe("张三");

    await lock.exit();
    expect(api.release).not.toHaveBeenCalled();
  });

  it("acquire 失败复位到 idle 并把错误抛给调用方", async () => {
    const api = mockApi();
    api.acquire.mockRejectedValue(new Error("network"));
    const lock = useKbDocLock(api);

    await expect(lock.enter("doc-1")).rejects.toThrow("network");
    expect(lock.state.value.phase).toBe("idle");
  });

  it("心跳 renewed=false → lost，且定时器停止", async () => {
    const api = mockApi();
    api.acquire.mockResolvedValue(HELD);
    api.heartbeat.mockResolvedValue({ renewed: false });
    const lock = useKbDocLock(api);

    await lock.enter("doc-1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lock.lost.value).toBe(true);

    // 定时器已停：再过一个周期也不会有心跳
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
  });

  it("心跳网络失败不判失锁，下一轮继续", async () => {
    const api = mockApi();
    api.acquire.mockResolvedValue(HELD);
    api.heartbeat
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ renewed: true });
    const lock = useKbDocLock(api);

    await lock.enter("doc-1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lock.held.value).toBe(true); // 误报失锁会打断正在打字的人

    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(lock.held.value).toBe(true);
  });

  it("exit 释放锁并停心跳；重复 exit 幂等", async () => {
    const api = mockApi();
    api.acquire.mockResolvedValue(HELD);
    api.release.mockResolvedValue({ released: true });
    const lock = useKbDocLock(api);

    await lock.enter("doc-1");
    await lock.exit();
    expect(api.release).toHaveBeenCalledWith("doc-1");
    expect(lock.state.value.phase).toBe("idle");

    await vi.advanceTimersByTimeAsync(90_000);
    expect(api.heartbeat).not.toHaveBeenCalled();

    await lock.exit();
    expect(api.release).toHaveBeenCalledTimes(1);
  });

  it("release 失败被吞（TTL 到期由服务端回收）", async () => {
    const api = mockApi();
    api.acquire.mockResolvedValue(HELD);
    api.release.mockRejectedValue(new Error("network"));
    const lock = useKbDocLock(api);

    await lock.enter("doc-1");
    await expect(lock.exit()).resolves.toBeUndefined();
    expect(lock.state.value.phase).toBe("idle");
  });

  it("同一文档重复 enter 不重复取锁；换文档先释放旧锁", async () => {
    const api = mockApi();
    api.acquire.mockResolvedValue(HELD);
    api.release.mockResolvedValue({ released: true });
    const lock = useKbDocLock(api);

    await lock.enter("doc-1");
    await lock.enter("doc-1");
    expect(api.acquire).toHaveBeenCalledTimes(1);

    await lock.enter("doc-2");
    expect(api.release).toHaveBeenCalledWith("doc-1");
    expect(api.acquire).toHaveBeenCalledWith("doc-2");
    expect(lock.held.value).toBe(true);
  });
});
