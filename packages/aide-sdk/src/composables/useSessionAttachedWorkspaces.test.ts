import { beforeEach, describe, expect, it } from "vitest";
import { useSessionAttachedWorkspaces } from "./useSessionAttachedWorkspaces";

describe("useSessionAttachedWorkspaces", () => {
  beforeEach(() => useSessionAttachedWorkspaces().clearAll());

  it("无记录时读点回落空数组（不返回 undefined）", () => {
    const s = useSessionAttachedWorkspaces();
    expect(s.attachedOf("nope")).toEqual([]);
    expect(s.rejectedOf("nope")).toEqual([]);
    expect(s.errorOf("nope")).toBeUndefined();
  });

  it("setAll 是整份覆盖（事件发的是全量账本，幂等）", () => {
    const s = useSessionAttachedWorkspaces();
    s.setAll("s1", ["C:\\a", "C:\\b"]);
    expect(s.attachedOf("s1")).toEqual(["C:\\a", "C:\\b"]);
    s.setAll("s1", ["C:\\a", "C:\\b"]);
    expect(s.attachedOf("s1")).toEqual(["C:\\a", "C:\\b"]);
    s.setAll("s1", ["C:\\a"]);
    expect(s.attachedOf("s1")).toEqual(["C:\\a"]);
  });

  it("全空的 setAll 删条目（避免留下空壳）", () => {
    const s = useSessionAttachedWorkspaces();
    s.setAll("s1", ["C:\\a"]);
    s.setAll("s1", []);
    expect(s.attachedOf("s1")).toEqual([]);
    expect("s1" in s.attached).toBe(false);
  });

  it("回声（rejected / error）单独可读，不混进授权账本", () => {
    const s = useSessionAttachedWorkspaces();
    s.setAll("s1", ["C:\\a"], ["C:\\Windows"], "上一轮 applyFlagSettings 失败");
    expect(s.attachedOf("s1")).toEqual(["C:\\a"]);
    expect(s.rejectedOf("s1")).toEqual(["C:\\Windows"]);
    expect(s.errorOf("s1")).toBe("上一轮 applyFlagSettings 失败");
  });

  it("migrate 把临时 id 的账本搬给真实 id（finalizeSession 链上的一环）", () => {
    const s = useSessionAttachedWorkspaces();
    s.setAll("temp", ["C:\\a"], ["C:\\Windows"]);
    s.migrate("temp", "real");
    expect(s.attachedOf("temp")).toEqual([]);
    expect(s.attachedOf("real")).toEqual(["C:\\a"]);
    expect(s.rejectedOf("real")).toEqual(["C:\\Windows"]);
  });

  it("removeWorkspace 收口单条，clearAll 归零全部", () => {
    const s = useSessionAttachedWorkspaces();
    s.setAll("s1", ["C:\\a"]);
    s.setAll("s2", ["C:\\b"]);
    s.removeWorkspace("s1");
    expect(s.attachedOf("s1")).toEqual([]);
    expect(s.attachedOf("s2")).toEqual(["C:\\b"]);
    s.clearAll();
    expect(s.attachedOf("s2")).toEqual([]);
    expect(Object.keys(s.attached)).toEqual([]);
  });
});
