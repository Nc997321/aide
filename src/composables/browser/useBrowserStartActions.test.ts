// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { blankDraftKey, __resetComposerDraftsForTest, useComposerDrafts } from "@aide/sdk/composables/useComposerDrafts";
import { useSessionNames } from "@aide/sdk/composables/useSessionNames";
const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../useMediaPreview", () => ({ useMediaPreview: () => ({ open }) }));
vi.mock("@aide/sdk/api/host", () => ({ hostApi: { identity: async () => ({ key: "local", label: "本机" }) } }));
vi.mock("@aide/sdk/api", () => ({ api: { sessionProfile: async () => "assistant" } }));
import { __resetPaneLayoutForTest, usePaneLayout } from "../usePaneLayout";
import { findGroup } from "../paneLayout/tree";
import { __resetRightPanelForTest, useRightPanel } from "../useRightPanel";
import { __resetBrowserHistoryForTest, useBrowserHistory } from "./useBrowserHistory";
import { useBrowserStartActions } from "./useBrowserStartActions";

beforeEach(() => {
  __resetComposerDraftsForTest();
  __resetPaneLayoutForTest();
  __resetRightPanelForTest();
  __resetBrowserHistoryForTest();
  localStorage.clear();
  open.mockReset().mockResolvedValue(undefined);
  for (const key of Object.keys(useSessionNames().names)) useSessionNames().removeName(key);
});

function currentBlankKey(): string {
  const { layout } = usePaneLayout();
  const group = findGroup(layout.root, layout.focusedGroupId);
  if (!group) throw new Error("missing focused group");
  return blankDraftKey(group.tabs.find((tab) => tab.id === group.activeTabId)?.id ?? `group:${group.id}`);
}

describe("browser start actions", () => {
  it("appends to the exact focused blank draft without sending or discarding existing content", async () => {
    const panes = usePaneLayout();
    panes.openBlankTab("Existing draft");
    const key = currentBlankKey();
    useComposerDrafts().draftOf(key).text = "原有草稿";
    useRightPanel().ensureBrowserShown();
    useRightPanel().setMaximized(true);
    useBrowserStartActions().prepareCreation({ mode: "create", brief: "一支 30 秒的介绍片" });
    expect(useComposerDrafts().draftOf(key).text).toContain("原有草稿\n\n");
    expect(useComposerDrafts().draftOf(key).text).toContain("一支 30 秒的介绍片");
    expect(panes.activeSessionId.value).toBe("");
    expect(useRightPanel().wantMaximized.value).toBe(false);
    expect(useBrowserHistory().records.value[0]).toMatchObject({ kind: "creation", target: { kind: "draft", key } });
    await flushPromises();
    expect(JSON.parse(localStorage.getItem("aide:browser-history:v1:local") || "{}").records).toEqual([]);
  });

  it("uses the same hero draft key as the chat input when no tab is open", () => {
    const key = currentBlankKey();
    useBrowserStartActions().prepareCreation({ mode: "edit", brief: "剪到一分钟" });
    expect(useComposerDrafts().draftOf(key).text).toContain("剪到一分钟");
    expect(usePaneLayout().hasAnyTab.value).toBe(false);
  });

  it("persists a creation pointing at an existing saved session", async () => {
    useSessionNames().setName("saved-session", "已有会话");
    usePaneLayout().openSession("saved-session");
    useBrowserStartActions().prepareCreation({ mode: "edit", brief: "加字幕" });
    await flushPromises();
    expect(useBrowserHistory().records.value[0]).toMatchObject({ target: { kind: "session", key: "saved-session" } });
    expect(useComposerDrafts().draftOf("saved-session").text).toContain("加字幕");
  });

  it("reopens media through the original session and source file", async () => {
    await useBrowserStartActions().resume({ kind: "media", title: "Clip", path: "/project/clip.mp4", visitedAt: 1, target: { kind: "session", key: "original" } });
    expect(usePaneLayout().activeSessionId.value).toBe("original");
    expect(open).toHaveBeenCalledExactlyOnceWith({ files: [{ path: "/project/clip.mp4", title: "clip.mp4" }], selected: 0, draftKey: "original" });
  });

  it("rejects closed draft targets instead of sending feedback to another conversation", async () => {
    await expect(useBrowserStartActions().resume({ kind: "media", title: "Clip", path: "/clip.mp4", visitedAt: 1, target: { kind: "draft", key: "blank:closed-tab" } })).rejects.toThrow("原草稿已关闭");
    expect(open).not.toHaveBeenCalled();
  });

  it("validates media selection and rejects empty creative briefs", async () => {
    await expect(useBrowserStartActions().openMedia("/document.txt")).rejects.toThrow("视频或音频");
    expect(() => useBrowserStartActions().prepareCreation({ mode: "create", brief: "  " })).toThrow("请先填写");
    expect(open).not.toHaveBeenCalled();
  });
});
