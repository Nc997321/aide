import { describe, it, expect, beforeEach } from "vitest";
import {
  resetWorkbenchState,
  setActiveWorkspace,
  genSessionId,
  addTab,
  removeTab,
  markExited,
  hasTabs,
  workspaceKeyOf,
  allSessionIds,
  killWorkspace,
  tabs,
  activeId,
} from "./workbenchTerminalState";

describe("workbenchTerminalState", () => {
  beforeEach(() => resetWorkbenchState());

  it("genSessionId 带工作空间归属且全局自增不复用", () => {
    const a1 = genSessionId("WS_A");
    const a2 = genSessionId("WS_A");
    const b1 = genSessionId("WS_B");
    expect(a1).toBe("__wb_WS_A__0");
    expect(a2).toBe("__wb_WS_A__1");
    expect(b1).toBe("__wb_WS_B__2");
  });

  it("addTab 进对应工作空间分组并设为该组激活 tab；tabs/activeId 只反映当前工作空间", () => {
    setActiveWorkspace("WS_A");
    addTab("WS_A", { id: genSessionId("WS_A"), label: "1", shellName: "bash", exited: false, kind: "shell" });
    addTab("WS_A", { id: genSessionId("WS_A"), label: "2", shellName: "bash", exited: false, kind: "shell" });
    expect(tabs.value.map(t => t.label)).toEqual(["1", "2"]);
    expect(activeId.value).toBe("__wb_WS_A__1");

    // 切到 B：A 的 tab 不可见，B 为空
    setActiveWorkspace("WS_B");
    expect(tabs.value).toEqual([]);
    expect(activeId.value).toBe("");

    // 切回 A：仍是 A 的第二个 tab 激活
    setActiveWorkspace("WS_A");
    expect(activeId.value).toBe("__wb_WS_A__1");
  });

  it("removeTab 删对应 tab，激活回退到最后一个；组空则删组", () => {
    const t1 = genSessionId("WS_A");
    const t2 = genSessionId("WS_A");
    addTab("WS_A", { id: t1, label: "1", shellName: "bash", exited: false, kind: "shell" });
    addTab("WS_A", { id: t2, label: "2", shellName: "bash", exited: false, kind: "shell" });
    setActiveWorkspace("WS_A");

    expect(removeTab(t2)).toEqual({ workspaceKey: "WS_A" });
    expect(activeId.value).toBe(t1);

    expect(removeTab(t1)).toEqual({ workspaceKey: "WS_A" });
    expect(hasTabs("WS_A")).toBe(false);
    expect(activeId.value).toBe("");
  });

  it("removeTab 找不到返回 null", () => {
    expect(removeTab("nope")).toBeNull();
  });

  it("markExited 只标对应 tab，不影响其它", () => {
    const t1 = genSessionId("WS_A");
    const t2 = genSessionId("WS_A");
    addTab("WS_A", { id: t1, label: "1", shellName: "bash", exited: false, kind: "shell" });
    addTab("WS_A", { id: t2, label: "2", shellName: "bash", exited: false, kind: "shell" });
    expect(markExited(t1)).toBe(true);
    expect(markExited("nope")).toBe(false);
    setActiveWorkspace("WS_A");
    expect(tabs.value.find(t => t.id === t1)?.exited).toBe(true);
    expect(tabs.value.find(t => t.id === t2)?.exited).toBe(false);
  });

  it("workspaceKeyOf / allSessionIds 跨工作空间查找", () => {
    const a = genSessionId("WS_A");
    const b = genSessionId("WS_B");
    addTab("WS_A", { id: a, label: "1", shellName: "", exited: false, kind: "shell" });
    addTab("WS_B", { id: b, label: "1", shellName: "", exited: false, kind: "run" });
    expect(workspaceKeyOf(a)).toBe("WS_A");
    expect(workspaceKeyOf(b)).toBe("WS_B");
    expect(allSessionIds().sort()).toEqual([a, b].sort());
  });

  it("killWorkspace 返回该组所有 session id 并清组", () => {
    const a1 = genSessionId("WS_A");
    const a2 = genSessionId("WS_A");
    addTab("WS_A", { id: a1, label: "1", shellName: "", exited: false, kind: "shell" });
    addTab("WS_A", { id: a2, label: "2", shellName: "", exited: false, kind: "shell" });
    const killed = killWorkspace("WS_A").sort();
    expect(killed).toEqual([a1, a2].sort());
    expect(hasTabs("WS_A")).toBe(false);
  });

  it("run tab 与 shell tab 同组共存，kind 区分", () => {
    const s = genSessionId("WS_A");
    addTab("WS_A", { id: s, label: "dev", shellName: "", exited: false, kind: "run" });
    setActiveWorkspace("WS_A");
    expect(tabs.value[0].kind).toBe("run");
  });
});
