// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { __resetComposerDraftsForTest, useComposerDrafts } from "@aide/sdk/composables/useComposerDrafts";
const { identity } = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("@aide/sdk/api/host", () => ({ hostApi: { identity } }));
import { __resetBrowserHistoryForTest, useBrowserHistory } from "./useBrowserHistory";
import { recentKey } from "./useBrowserHistory/model";

const KEY = "aide:browser-history:v1:local";
beforeEach(() => {
  __resetBrowserHistoryForTest();
  __resetComposerDraftsForTest();
  localStorage.clear();
  identity.mockReset().mockResolvedValue({ key: "local", label: "本机" });
});

describe("browser history persistence", () => {
  it("records only successful navigation and survives a reload", async () => {
    const history = useBrowserHistory();
    history.recordNavigation({ state: "loading", url: "https://example.test/" });
    history.recordNavigation({ state: "failed", url: "https://example.test/", reason: "offline" });
    expect(history.records.value).toEqual([]);
    history.recordNavigation({ state: "ready", url: "https://example.test/", title: "Example" });
    await flushPromises();
    expect(JSON.parse(localStorage.getItem(KEY) || "{}").records).toHaveLength(1);
    __resetBrowserHistoryForTest();
    await useBrowserHistory().initialize();
    expect(useBrowserHistory().records.value[0]?.title).toBe("Example");
  });

  it("keeps Host histories and bookmark preferences isolated", async () => {
    const history = useBrowserHistory();
    history.setBookmarkBar(true);
    history.recordNavigation({ state: "ready", url: "https://local.test/", title: "Local" });
    await flushPromises();
    __resetBrowserHistoryForTest();
    identity.mockResolvedValue({ key: "wsl:Test", label: "WSL" });
    await history.initialize();
    expect(history.records.value).toEqual([]);
    expect(history.showBookmarkBar.value).toBe(false);
    history.recordNavigation({ state: "ready", url: "https://remote.test/", title: "Remote" });
    await flushPromises();
    expect(JSON.parse(localStorage.getItem(KEY) || "{}").records[0].title).toBe("Local");
    expect(localStorage.getItem("aide:browser-history:v1:wsl:Test")).toContain("Remote");
  });

  it("migrates blank → temporary → confirmed targets only after finalization", async () => {
    const history = useBrowserHistory();
    const drafts = useComposerDrafts();
    drafts.draftOf("blank:tab-1").text = "片子";
    history.record({ kind: "media", title: "clip", path: "/clip.mp4", target: { kind: "draft", key: "blank:tab-1" } });
    await flushPromises();
    expect(JSON.parse(localStorage.getItem(KEY) || "{}").records).toEqual([]);
    drafts.migrateDraft("blank:tab-1", "temporary");
    drafts.migrateDraft("temporary", "confirmed");
    history.finalizeSession("confirmed");
    await flushPromises();
    expect(JSON.parse(localStorage.getItem(KEY) || "{}").records[0].target).toEqual({ kind: "session", key: "confirmed" });
  });

  it("removes records and restores their original visit time", async () => {
    const history = useBrowserHistory();
    history.recordNavigation({ state: "ready", url: "https://example.test/", title: "Example" });
    await flushPromises();
    const original = history.records.value[0];
    expect(original).toBeDefined();
    if (!original) return;
    const removed = history.remove(recentKey(original));
    expect(history.records.value).toHaveLength(0);
    expect(removed).toEqual(original);
    if (removed) history.restore(removed);
    await flushPromises();
    expect(history.records.value[0]?.visitedAt).toBe(original.visitedAt);
  });

  it("does not resurrect a record removed while Host identity is still loading", async () => {
    let finish: ((host: { key: string }) => void) | undefined;
    identity.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const saved = { kind: "web", title: "Example", url: "https://example.test/", visitedAt: 1 } as const;
    localStorage.setItem(KEY, JSON.stringify({ version: 1, records: [saved], showBookmarkBar: false }));
    const history = useBrowserHistory();
    history.recordNavigation({ state: "ready", url: saved.url, title: saved.title });
    const key = history.records.value[0];
    if (!key) throw new Error("expected in-memory visit");
    history.remove(recentKey(key));
    if (!finish) throw new Error("Host identity lookup was not started");
    finish({ key: "local" });
    await flushPromises();
    expect(history.records.value).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(KEY) || "{}").records).toHaveLength(0);
  });

  it("does not replace corrupted storage, and surfaces the failure", async () => {
    localStorage.setItem(KEY, "broken-data");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    useBrowserHistory().recordNavigation({ state: "ready", url: "https://example.test/", title: "Example" });
    await flushPromises();
    expect(localStorage.getItem(KEY)).toBe("broken-data");
    expect(useBrowserHistory().error.value).toContain("暂未保存");
    warning.mockRestore();
  });

  it("does not use a local fallback if Host identity is unavailable", async () => {
    identity.mockRejectedValue(new Error("offline"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    useBrowserHistory().recordNavigation({ state: "ready", url: "https://example.test/", title: "Example" });
    await flushPromises();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(useBrowserHistory().error.value).toContain("offline");
    warning.mockRestore();
  });
});
