import { beforeEach, describe, expect, it, vi } from "vitest";

const kbLinksMock = vi.fn();
const setKbLinksMock = vi.fn();
const listWorkspacesMock = vi.fn();
vi.mock("@aide/sdk/api", () => ({
  api: new Proxy(
    { kbLinks: (...a: unknown[]) => kbLinksMock(...a), setKbLinks: (...a: unknown[]) => setKbLinksMock(...a), listWorkspaces: (...a: unknown[]) => listWorkspacesMock(...a) },
    { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : vi.fn(async () => undefined)) },
  ),
}));
vi.mock("../api", async () => ({ api: (await import("@aide/sdk/api")).api }));

import { __resetKbLinksForTest, effectiveLinks, useKbLinks } from "./useKbLinks";
import { useWorkspaces } from "./useWorkspaces";

beforeEach(() => {
  __resetKbLinksForTest();
  kbLinksMock.mockReset().mockResolvedValue({});
  setKbLinksMock.mockReset();
  listWorkspacesMock.mockReset().mockResolvedValue([]);
  useWorkspaces().workspaces.value = [];
});

describe("effectiveLinks：自己的在前，祖先继承在后，取并集去重", () => {
  const table = { doc: ["a"], near: ["b", "a"], far: ["c"] };
  it("顺序与来源", () => {
    expect(effectiveLinks(table, "doc", ["near", "far"])).toEqual([
      { key: "a", from: "direct" },
      { key: "b", from: "near" },
      { key: "c", from: "far" },
    ]);
  });
  it("同一个工作区只出现一次，保留最先的来源", () => {
    expect(effectiveLinks(table, "doc", ["near"]).filter((l) => l.key === "a")).toEqual([{ key: "a", from: "direct" }]);
  });
  it("没有任何关联 → 空", () => {
    expect(effectiveLinks({}, "x", ["y"])).toEqual([]);
  });
});

describe("useKbLinks", () => {
  it("load 读全表；失败不抛、不缓存失败（下次还能重试）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    kbLinksMock.mockRejectedValueOnce(new Error("down"));
    const k = useKbLinks();
    await k.load();
    expect(k.table.value).toEqual({});
    kbLinksMock.mockResolvedValueOnce({ d1: ["ws-a"] });
    await k.load();
    expect(k.table.value).toEqual({ d1: ["ws-a"] });
    warn.mockRestore();
  });

  it("resolve：认得的工作区给路径与目录名；不认得的标缺失，不静默丢", () => {
    useWorkspaces().workspaces.value = [{ key: "ws-a", name: "/home/u/proj-a", missing: false }];
    const k = useKbLinks();
    expect(k.resolve("ws-a")).toEqual({ key: "ws-a", path: "/home/u/proj-a", label: "proj-a", missing: false });
    expect(k.resolve("ws-gone")).toMatchObject({ key: "ws-gone", path: "", missing: true });
  });

  it("rootsOf：只下发存在的工作区路径（缺失的读不到记忆，不给）", () => {
    useWorkspaces().workspaces.value = [
      { key: "ws-a", name: "/home/u/proj-a", missing: false },
      { key: "ws-b", name: "/home/u/proj-b", missing: true },
    ];
    const k = useKbLinks();
    expect(k.rootsOf([{ key: "ws-a", from: "direct" }, { key: "ws-b", from: "f" }, { key: "ws-x", from: "f" }])).toEqual(["/home/u/proj-a"]);
  });

  it("toggle：已有就摘掉，没有就加上；全表以后端回执为准", async () => {
    kbLinksMock.mockResolvedValue({ d1: ["ws-a"] });
    const k = useKbLinks();
    await k.load();
    setKbLinksMock.mockResolvedValueOnce({ d1: ["ws-a", "ws-b"] });
    await k.toggle("d1", "ws-b");
    expect(setKbLinksMock).toHaveBeenLastCalledWith("d1", ["ws-a", "ws-b"]);
    setKbLinksMock.mockResolvedValueOnce({});
    await k.toggle("d1", "ws-a");
    expect(setKbLinksMock).toHaveBeenLastCalledWith("d1", ["ws-b"]);
  });
});
