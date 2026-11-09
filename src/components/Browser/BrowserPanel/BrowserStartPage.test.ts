// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
vi.mock("@aide/sdk/api/host", () => ({ hostApi: { identity: async () => ({ key: "local", label: "本机" }) } }));
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import BrowserStartPage from "./BrowserStartPage.vue";
import { __resetBrowserHistoryForTest, useBrowserHistory } from "../../../composables/browser/useBrowserHistory";
import { useBrowserBookmarks } from "../../../composables/browser/useBrowserBookmarks";

let mounted: VueWrapper | undefined;
beforeEach(() => {
  __resetBrowserHistoryForTest();
  invoke.mockReset().mockResolvedValue({});
  useBrowserBookmarks().favicons.value = {};
  localStorage.clear();
  const history = useBrowserHistory();
  history.recordNavigation({ state: "ready", url: "https://example.test/", title: "网页记录" });
  history.record({ kind: "creation", mode: "edit", title: "字幕剪辑", target: { kind: "session", key: "session-1" } });
  history.record({ kind: "media", title: "录屏", path: "/clip.mp4", target: { kind: "session", key: "session-1" } });
});
afterEach(async () => { mounted?.unmount(); mounted = undefined; await flushPromises(); });

function render(): VueWrapper {
  mounted = mount(BrowserStartPage);
  return mounted;
}

describe("browser start page", () => {
  it("filters unified recent records by type", async () => {
    const w = render();
    expect(w.findAll(".browser-recent-row")).toHaveLength(3);
    await w.findAll(".browser-start-filters button")[1]?.trigger("click");
    expect(w.findAll(".browser-recent-title").map((item) => item.text())).toEqual(["网页记录"]);
    await w.findAll(".browser-start-filters button")[2]?.trigger("click");
    expect(w.findAll(".browser-recent-title").map((item) => item.text())).toEqual(["字幕剪辑"]);
  });

  it("uses cached icons for recent pages that were never bookmarked", async () => {
    invoke.mockResolvedValueOnce({ "https://example.test/": "data:image/png;base64,CACHED" });
    const w = render();
    await flushPromises();
    expect(invoke).toHaveBeenCalledWith("browser_favicons", { urls: ["https://example.test/"] });
    expect(w.find(".browser-site-icon img").attributes("src")).toBe("data:image/png;base64,CACHED");
  });

  it("loads the site's standard icon on a cache miss and retains non-web icons", async () => {
    const w = render();
    await flushPromises();
    expect(w.find(".browser-site-icon img").attributes("src")).toBe("https://example.test/favicon.ico");
    expect(w.findAll(".browser-site-icon")).toHaveLength(1);
    expect(w.findAll(".browser-recent-icon > .aide-icon-host")).toHaveLength(2);
  });

  it("removes only the record and provides an undo action", async () => {
    const w = render();
    await w.find(".browser-recent-remove").trigger("click");
    expect(w.findAll(".browser-recent-row")).toHaveLength(2);
    expect(w.find(".browser-recents-undo").text()).toContain("不会删除文件或会话");
    await w.find(".browser-recents-undo button").trigger("click");
    expect(w.findAll(".browser-recent-row")).toHaveLength(3);
  });

  it("routes the three actions and never renders the removed introduction block", async () => {
    const w = render();
    const tools = w.findAll(".browser-start-tool");
    await tools[0]?.trigger("click");
    await tools[1]?.trigger("click");
    await tools[2]?.trigger("click");
    expect(w.emitted("create")).toEqual([["create"], ["edit"]]);
    expect(w.emitted("media")).toEqual([[]]);
    expect(w.find("h1").exists()).toBe(false);
    expect(w.text()).not.toContain("打开网页，或接着上次");
  });
});
