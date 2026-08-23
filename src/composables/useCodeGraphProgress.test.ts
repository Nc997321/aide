import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api", () => ({
  api: {
    isWorkspaceTrusted: vi.fn(async () => true),
    codegraphBuildIndex: vi.fn(async () => ({ loaded: true, total_symbols: 10 })),
    codegraphClose: vi.fn(async () => undefined),
    codegraphRescan: vi.fn(async () => ({
      active_index: true,
      embed_ready: true,
      changed_files: 0,
      rescanned_files: 0,
      errors: 0,
    })),
    codegraphBuildProgress: vi.fn(async () => ({ active: false, done: 0, total: 0, current: "", index_ready: true })),
    loadNotifications: vi.fn(async () => []),
    saveNotifications: vi.fn(async () => undefined),
  },
}));

import { useCodeGraphProgress } from "./useCodeGraphProgress";
import { useNotifications } from "./useNotifications";
import { api } from "../api";

describe("useCodeGraphProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 组件运行在有 window 的 WebView；测试环境是 node，需要补 window 让
    // scheduleRescan / startPoll 的 `typeof window` 守卫走真实分支。
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    useCodeGraphProgress().__resetForTest();
    vi.clearAllMocks();
  });

  afterEach(() => {
    useCodeGraphProgress().__resetForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("scheduleRescan 防抖：密集调用合并为一次 rescan", async () => {
    const cg = useCodeGraphProgress();
    await cg.ensureIndex("C:/proj");
    cg.scheduleRescan();
    cg.scheduleRescan();
    cg.scheduleRescan();
    await vi.advanceTimersByTimeAsync(2999);
    expect(api.codegraphRescan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.codegraphRescan).toHaveBeenCalledTimes(1);
    expect(api.codegraphRescan).toHaveBeenCalledWith("C:/proj");
  });

  it("未建索引（无 root）时 scheduleRescan 是 no-op", async () => {
    useCodeGraphProgress().scheduleRescan();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.codegraphRescan).not.toHaveBeenCalled();
  });

  it("空 root（无显式工作区）不触发构建、不推通知", async () => {
    const cg = useCodeGraphProgress();
    cg.ensureIndex("");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.codegraphBuildIndex).not.toHaveBeenCalled();
    const codegraphNotes = useNotifications()
      .notifications.value.filter((n) => n.source === "codegraph");
    expect(codegraphNotes).toHaveLength(0);
  });

  it("embed 未完成的构建结果推「语义搜索不可用」警告", async () => {
    vi.mocked(api.codegraphBuildIndex).mockResolvedValueOnce({
      loaded: false,
      total_symbols: 100,
      has_embeddings: false,
      embed_status: "cancelled at 10/100",
    });
    useCodeGraphProgress().ensureIndex("C:/proj2");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const codegraphNotes = useNotifications()
      .notifications.value.filter((n) => n.source === "codegraph");
    expect(codegraphNotes).toHaveLength(1);
    expect(codegraphNotes[0].severity).toBe("warning");
  });

  it("切换 root 时 close 上一个索引失败 → warn + 仍 build 新 root（close 失败不吞 build）", async () => {
    const cg = useCodeGraphProgress();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cg.ensureIndex("C:/proj-a");
    vi.mocked(api.codegraphClose).mockRejectedValueOnce(new Error("close boom"));
    await cg.ensureIndex("C:/proj-b");
    // close 链是 fire-and-forget（void）：await ensureIndex 不等它，reject→catch→
    // finally(build) 的微任务链要 flush 后才执行 build 的同步调用。
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    // close 失败走 warn（不静默），.finally(build) 保证新 root 照常建索引
    expect(api.codegraphBuildIndex).toHaveBeenCalledWith("C:/proj-b");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[codegraph] close previous index failed"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
