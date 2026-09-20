import { describe, it, expect, beforeEach } from "vitest";
import {
  isDailyKey,
  dailyWorkspaceBind,
  visibleWorkspaces,
  setDailyWorkspace,
  __resetDailyWorkspaceForTest,
} from "./dailyWorkspace";
import type { WorkspaceInfo } from "../types";

const ws = (key: string, name: string): WorkspaceInfo => ({ key, name, missing: false });

describe("dailyWorkspace", () => {
  beforeEach(() => __resetDailyWorkspaceForTest());

  it("日常归属未装载前，任何 key 都不是日常", () => {
    expect(isDailyKey("C--Users-heaven-.aide-workspace")).toBe(false);
    expect(isDailyKey(null)).toBe(false);
    expect(isDailyKey("")).toBe(false);
    expect(isDailyKey(undefined)).toBe(false);
  });

  it("只有日常那一个 key 判定为真", () => {
    setDailyWorkspace("C--cfg-workspace", "C:/cfg/workspace");
    expect(isDailyKey("C--cfg-workspace")).toBe(true);
    expect(isDailyKey("C--cfg-other")).toBe(false);
    expect(isDailyKey("")).toBe(false);
  });

  it("dailyWorkspaceBind 给出会话归属绑定（空白 tab / hero 落点用）", () => {
    expect(dailyWorkspaceBind()).toBeNull();
    setDailyWorkspace("C--cfg-workspace", "C:/cfg/workspace");
    expect(dailyWorkspaceBind()).toEqual({
      wsKey: "C--cfg-workspace",
      wsPath: "C:/cfg/workspace",
    });
  });

  it("visibleWorkspaces 只剔除日常，其余顺序不动", () => {
    setDailyWorkspace("daily", "C:/cfg/workspace");
    const list = [ws("a", "A"), ws("daily", "D"), ws("b", "B")];
    expect(visibleWorkspaces(list).map((w) => w.key)).toEqual(["a", "b"]);
  });

  it("visibleWorkspaces 不原地改入参（调用方可能还在用原列表）", () => {
    setDailyWorkspace("daily", "C:/cfg/workspace");
    const list = [ws("a", "A"), ws("daily", "D")];
    visibleWorkspaces(list);
    expect(list.map((w) => w.key)).toEqual(["a", "daily"]);
  });
});
