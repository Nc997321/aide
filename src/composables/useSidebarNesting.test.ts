import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarNesting } from "./useSidebarNesting";
import { __resetSubsessionsForTest, noteSubsessionStarted } from "./useSubsessions";
import { useSessionState } from "./useSessionState";
import type { Session } from "@/types";

const sess = (id: string, parentId?: string): Session => ({ id, name: id, timestamp: 0, ...(parentId ? { parentId } : {}) });

describe("useSidebarNesting", () => {
  const { setSessionState, removeSessionState } = useSessionState();
  beforeEach(() => {
    __resetSubsessionsForTest();
    for (const id of ["p", "a", "b", "q"]) removeSessionState(id);
  });

  it("子会话不在顶层；父会话不在列表里的子会话照常顶层显示", () => {
    const n = useSidebarNesting(() => "");
    const list = [sess("p"), sess("a", "p"), sess("orphan", "gone")];
    expect(n.topLevel(list).map((s) => s.id)).toEqual(["p", "orphan"]);
  });

  it("流光往上冒：子会话等批准 → 父会话行变黄；默认收起，有等批准的自动展开", () => {
    noteSubsessionStarted("p", "a", "A");
    noteSubsessionStarted("p", "b", "B");
    setSessionState("p", "waiting");
    setSessionState("a", "running");
    setSessionState("b", "waiting");
    const n = useSidebarNesting(() => "");
    expect(n.rowTone("p")).toBe("running");
    expect(n.childBadge("p")).toBe("1/2");
    expect(n.rows([sess("p")]).map((r) => r.id)).toEqual(["p"]);

    setSessionState("b", "attention");
    expect(n.rowTone("p")).toBe("attention");
    expect(n.rows([sess("p")]).map((r) => [r.id, r.child])).toEqual([["p", false], ["a", true], ["b", true]]);
  });

  it("正看着某个子会话时父会话展开；徽标点击手动开合", () => {
    noteSubsessionStarted("q", "c", "C");
    const viewing = useSidebarNesting(() => "c");
    expect(viewing.isExpanded("q")).toBe(true);
    const n = useSidebarNesting(() => "");
    expect(n.isExpanded("q")).toBe(false);
    n.toggle("q");
    expect(n.isExpanded("q")).toBe(true);
    n.toggle("q");
    expect(n.isExpanded("q")).toBe(false);
  });
});
