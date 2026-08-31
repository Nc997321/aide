// @vitest-environment jsdom
// jsdom：门面 import useNotifications（通知中心初始化链路），组件层组件单测也
// 在 jsdom 下跑，保持一致。window 仍由 stubGlobal 覆盖（fake timers）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api", () => ({
  api: {
    isWorkspaceTrusted: vi.fn(async () => true),
    isWorkspaceCodegraphEnabled: vi.fn(async () => true),
    setWorkspaceCodegraphEnabled: vi.fn(async () => undefined),
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
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(true);
    vi.mocked(api.isWorkspaceTrusted).mockResolvedValue(true);
    useCodeGraphProgress().__resetForTest();
    // 通知中心也是模块级单例：既有用例推的 codegraph 通知会泄漏到后续用例
    useNotifications().__resetForTest();
    vi.clearAllMocks();
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(true);
    vi.mocked(api.isWorkspaceTrusted).mockResolvedValue(true);
  });

  afterEach(() => {
    useCodeGraphProgress().__resetForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function codegraphNotes() {
    return useNotifications()
      .notifications.value.filter((n) => n.source === "codegraph");
  }

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
    expect(codegraphNotes()).toHaveLength(0);
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
    const notes = codegraphNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe("warning");
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

  it("工作区默认关：ensureIndex 完全静默（不 build、不调 close、不推通知）", async () => {
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(false);
    const cg = useCodeGraphProgress();
    cg.ensureIndex("C:/proj-never-enabled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.codegraphBuildIndex).not.toHaveBeenCalled();
    expect(codegraphNotes()).toHaveLength(0);
  });

  it("从开启索引的工作区切到未开工作区：释放前者的活跃索引", async () => {
    const cg = useCodeGraphProgress();
    await cg.ensureIndex("C:/proj-on");
    expect(api.codegraphBuildIndex).toHaveBeenCalledWith("C:/proj-on");
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(false);
    await cg.ensureIndex("C:/proj-off");
    // closeActive 只 close 上一个活跃 root，绝不动未开工作区
    expect(api.codegraphClose).toHaveBeenCalledWith("C:/proj-on");
    expect(api.codegraphBuildIndex).not.toHaveBeenCalledWith("C:/proj-off");
    expect(cg.isRootEnabled("C:/proj-off")).toBe(false);
  });

  it("开关关：rescan/rebuild/reindexFile 同步短路 no-op", async () => {
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(false);
    const cg = useCodeGraphProgress();
    await cg.refreshEnabledFor("C:/proj");
    await cg.rescan("C:/proj");
    expect(api.codegraphRescan).not.toHaveBeenCalled();
    cg.rebuild("C:/proj");
    expect(api.codegraphBuildIndex).not.toHaveBeenCalled();
    const r = await cg.reindexFile("C:/proj", "proj/A.ts");
    expect(r).toBeNull();
    expect(api.codegraphReindexFile).not.toHaveBeenCalled();
  });

  it("开关开关读失败按关（安全侧）", async () => {
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockRejectedValue(new Error("ipc down"));
    const cg = useCodeGraphProgress();
    expect(await cg.refreshEnabledFor("C:/proj")).toBe(false);
    expect(cg.isRootEnabled("C:/proj")).toBe(false);
  });

  it("setRootEnabled(false)：先落盘再释放该 root 的活跃索引", async () => {
    const cg = useCodeGraphProgress();
    await cg.ensureIndex("C:/proj");
    expect(api.codegraphBuildIndex).toHaveBeenCalledWith("C:/proj");
    // 模拟落盘后后端权威值变化（生产中 state.json 写入后读回即 false）
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(false);
    await cg.setRootEnabled("C:/proj", false);
    expect(api.setWorkspaceCodegraphEnabled).toHaveBeenCalledWith("C:/proj", false);
    expect(api.codegraphClose).toHaveBeenCalledWith("C:/proj");
    expect(cg.isRootEnabled("C:/proj")).toBe(false);
  });

  it("setRootEnabled(true)：落盘 + 清守卫并对该工作区立即重建", async () => {
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(false);
    const cg = useCodeGraphProgress();
    await cg.ensureIndex("C:/proj"); // 开关未开：静默
    expect(api.codegraphBuildIndex).not.toHaveBeenCalled();
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(true);
    await cg.setRootEnabled("C:/proj", true);
    expect(api.setWorkspaceCodegraphEnabled).toHaveBeenCalledWith("C:/proj", true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(cg.isRootEnabled("C:/proj")).toBe(true);
    expect(api.codegraphBuildIndex).toHaveBeenCalledWith("C:/proj");
  });

  it("顺序防回归：未开 + 不信任 → 完全静默；开了 + 不信任才弹「工作区不受信任」", async () => {
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(false);
    vi.mocked(api.isWorkspaceTrusted).mockResolvedValue(false);
    const cg = useCodeGraphProgress();
    cg.ensureIndex("C:/untrusted-off");
    await vi.advanceTimersByTimeAsync(1000);
    // 开关门在 trust 门之前：未开索引 → 不弹信任通知（否则默认关 = 满屏提醒）
    expect(codegraphNotes()).toHaveLength(0);

    // 开了工作区开关（setRootEnabled 落盘 + 拉权威置缓存）但不信任 →
    // setRootEnabled 内触发的 ensureIndex 走既有 untrusted 通知流
    vi.mocked(api.isWorkspaceCodegraphEnabled).mockResolvedValue(true);
    await cg.setRootEnabled("C:/untrusted-off", true);
    await vi.advanceTimersByTimeAsync(1000);
    const notes = codegraphNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].dedupKey).toContain("codegraph:untrusted:");
    expect(notes[0].action?.label).toBe("信任此工作区");
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
    expect(codegraphNotes()).toHaveLength(0);
  });
});