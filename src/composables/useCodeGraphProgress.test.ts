// @vitest-environment jsdom
// jsdom：门面现在 import useSettings（模块级 watch 写 document.documentElement 的
// CSS 变量），node 环境没有 document。window 仍由 stubGlobal 覆盖（fake timers）。
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
    codegraphReindexFile: vi.fn(async () => ({ reindexed: true })),
    codegraphBuildProgress: vi.fn(async () => ({ active: false, done: 0, total: 0, current: "", index_ready: true })),
    loadNotifications: vi.fn(async () => []),
    saveNotifications: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
  },
}));

import { useCodeGraphProgress } from "./useCodeGraphProgress";
import { useNotifications } from "./useNotifications";
import { useSettings } from "./useSettings";
import { api } from "../api";

describe("useCodeGraphProgress", () => {
  beforeEach(async () => {
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
    // 通知中心也是模块级单例：既有用例推的 codegraph 通知会泄漏到后续用例
    useNotifications().__resetForTest();
    // 总开关是模块级 settings 单例，跨用例共享——每例复位为开，防泄漏
    await useSettings().update({ codegraphEnabled: true });
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

  it("总开关关闭：ensureIndex 不建索引、不推通知", async () => {
    await useSettings().update({ codegraphEnabled: false });
    const cg = useCodeGraphProgress();
    cg.ensureIndex("C:/proj");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.codegraphBuildIndex).not.toHaveBeenCalled();
    const codegraphNotes = useNotifications()
      .notifications.value.filter((n) => n.source === "codegraph");
    expect(codegraphNotes).toHaveLength(0);
  });

  it("总开关关闭：scheduleRescan/rescan/rebuild/reindexFile 全 no-op", async () => {
    await useSettings().update({ codegraphEnabled: false });
    const cg = useCodeGraphProgress();
    cg.scheduleRescan();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.codegraphRescan).not.toHaveBeenCalled();
    await cg.rescan("C:/proj");
    expect(api.codegraphRescan).not.toHaveBeenCalled();
    cg.rebuild("C:/proj");
    expect(api.codegraphBuildIndex).not.toHaveBeenCalled();
    const r = await cg.reindexFile("C:/proj", "proj/A.ts");
    expect(r).toBeNull();
    expect(api.codegraphReindexFile).not.toHaveBeenCalled();
  });

  it("setEnabled(false) 释放活跃索引（close 上一个）", async () => {
    const cg = useCodeGraphProgress();
    await cg.ensureIndex("C:/proj");
    expect(api.codegraphBuildIndex).toHaveBeenCalledWith("C:/proj");
    cg.setEnabled(false);
    expect(api.codegraphClose).toHaveBeenCalledWith("C:/proj");
  });

  it("setEnabled(true) 后对当前工作区立即重建", async () => {
    const cg = useCodeGraphProgress();
    await cg.ensureIndex("C:/proj");
    cg.setEnabled(false);
    expect(api.codegraphClose).toHaveBeenCalledWith("C:/proj");
    vi.mocked(api.codegraphBuildIndex).mockClear();
    cg.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.codegraphBuildIndex).toHaveBeenCalledWith("C:/proj");
  });

  it("Rust 门控 skipped 响应（untrusted/disabled）静默停 poll、不推通知", async () => {
    vi.mocked(api.codegraphBuildIndex).mockResolvedValueOnce({
      loaded: false,
      skipped: "disabled",
      total_symbols: 0,
    });
    useCodeGraphProgress().ensureIndex("C:/proj");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const codegraphNotes = useNotifications()
      .notifications.value.filter((n) => n.source === "codegraph");
    expect(codegraphNotes).toHaveLength(0);
  });
});
