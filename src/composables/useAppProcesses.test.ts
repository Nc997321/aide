import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppProcess } from "@aide/sdk/types/apps";

const processList = vi.fn<() => Promise<AppProcess[]>>();
const processKill = vi.fn(async (_runId: string) => {});
let onChanged: (() => void) | null = null;

vi.mock("@aide/sdk/api/apps", () => ({
  APP_PROCESSES_CHANGED_EVENT: "app-processes-changed",
  appsApi: { processList: () => processList(), processKill: (id: string) => processKill(id) },
}));
vi.mock("@aide/sdk", () => ({
  listen: vi.fn(async (_event: string, fn: () => void) => {
    onChanged = fn;
    return () => {};
  }),
}));

import {
  FINISHED_LINGER_MS,
  describeProcess,
  formatElapsed,
  processTone,
  resetAppProcessesForTest,
  useAppProcesses,
} from "./useAppProcesses";

const T0 = 1_000_000;
function proc(over: Partial<AppProcess> = {}): AppProcess {
  return {
    runId: "r1",
    appId: "tasks",
    workspace: "/ws/a",
    command: "npm run build",
    cwd: "",
    startedAt: T0,
    running: true,
    code: null,
    killed: false,
    endedAt: null,
    ...over,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetAppProcessesForTest();
  processList.mockReset();
  processKill.mockClear();
  onChanged = null;
});

describe("进程清单只认 Host 的回答", () => {
  it("启动时列一次，Host 说变了再列", async () => {
    processList.mockResolvedValueOnce([proc()]).mockResolvedValueOnce([]);
    const procs = useAppProcesses();
    procs.start();
    await flush();
    expect(procs.running.value.map((p) => p.runId)).toEqual(["r1"]);

    // 结束不本地改：发出去之后清单还在，等 Host 的事件
    await procs.kill("r1");
    expect(processKill).toHaveBeenCalledWith("r1");
    expect(procs.running.value).toHaveLength(1);
    onChanged?.();
    await flush();
    expect(procs.running.value).toHaveLength(0);
  });

  it("旧 Host 没有这条命令：安静地保持空清单", async () => {
    processList.mockRejectedValue(new Error("unknown command"));
    const procs = useAppProcesses();
    await procs.refresh();
    expect(procs.visible.value).toEqual([]);
  });

  it("刚结束的留几秒看结果，过了就不显示；在跑的一直显示", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(T0 + 60_000);
      const done = proc({ runId: "done", running: false, code: 0, endedAt: T0 + 60_000 - 1000 });
      const old = proc({ runId: "old", running: false, code: 1, endedAt: T0 + 60_000 - FINISHED_LINGER_MS - 1 });
      processList.mockResolvedValue([proc(), done, old]);
      const procs = useAppProcesses();
      await procs.refresh();
      expect(procs.visible.value.map((p) => p.runId)).toEqual(["r1", "done"]);
      await vi.advanceTimersByTimeAsync(FINISHED_LINGER_MS);
      expect(procs.visible.value.map((p) => p.runId)).toEqual(["r1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("「去那个工作区」交给 App 接上的切换入口", () => {
    const procs = useAppProcesses();
    const goto = vi.fn();
    procs.setWorkspaceSwitcher(goto);
    procs.gotoWorkspace("/ws/b");
    expect(goto).toHaveBeenCalledWith("/ws/b");
  });
});

describe("一行怎么说", () => {
  it("时长", () => {
    expect([formatElapsed(0), formatElapsed(42_900), formatElapsed(65_000), formatElapsed(-5)]).toEqual([
      "0 秒",
      "42 秒",
      "1 分 05 秒",
      "0 秒",
    ]);
  });

  it("在跑 / 跑完 / 失败 / 被结束 / 异常退出，各有各的说法和颜色", () => {
    const end = { running: false, endedAt: T0 + 5000 };
    const cases: [AppProcess, string, string][] = [
      [proc(), "已运行 12 秒", "running"],
      [proc({ ...end, code: 0 }), "完成 · 用时 5 秒", "ok"],
      [proc({ ...end, code: 2 }), "失败，退出码 2 · 用时 5 秒", "failed"],
      [proc({ ...end, code: null, killed: true }), "已结束 · 用时 5 秒", "stopped"],
      [proc({ ...end, code: null }), "异常退出 · 用时 5 秒", "failed"],
    ];
    for (const [p, text, tone] of cases) {
      expect(describeProcess(p, T0 + 12_000)).toBe(text);
      expect(processTone(p)).toBe(tone);
    }
  });
});
