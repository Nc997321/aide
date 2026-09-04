// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

const api = vi.hoisted(() => ({
  listMarketplaceSources: vi.fn(),
  fetchMarketplace: vi.fn(),
  listInstalledPlugins: vi.fn(),
  setMarketplaceEnabled: vi.fn(),
  refreshMarketplace: vi.fn(),
  installPlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  updatePlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
}));
vi.mock("../../api/marketplace", () => ({ marketplaceApi: api }));

import MarketplaceSidebarEntry from "./MarketplaceSidebarEntry.vue";
import { useMarketplace } from "../../composables/useMarketplace";

function mountEntry() {
  return mount(MarketplaceSidebarEntry, {
    global: { directives: { tooltip: {} } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MarketplaceSidebarEntry 侧栏入口（SidebarSectionHead 复用）", () => {
  it("渲染「插件」大导航行，点击整行切换主区面板开关", async () => {
    const m = useMarketplace();
    m.closePanel();
    const w = mountEntry();
    const head = w.find(".sec-head");
    expect(head.exists()).toBe(true);
    expect(w.text()).toContain("插件");
    // 面板关闭 → chevron 收起态
    expect(w.find(".chevron").classes()).not.toContain("expanded");

    await head.trigger("click");
    expect(m.panelOpen.value).toBe(true);
    await w.vm.$nextTick();
    expect(w.find(".chevron").classes()).toContain("expanded");

    await head.trigger("click");
    expect(m.panelOpen.value).toBe(false);
  });

  it("右槽位计数 = 已安装插件数（0 时不占位）", async () => {
    api.listInstalledPlugins.mockResolvedValue([
      {
        name: "a", market: "m", version: "1", versionId: "1", displayName: "A",
        description: "", author: "", path: "/x", installedAt: 1, enabled: true,
      },
    ]);
    const m = useMarketplace();
    await m.refreshInstalled();
    const w = mountEntry();
    expect(w.find(".sec-count").text()).toBe("1");

    api.listInstalledPlugins.mockResolvedValue([]);
    await m.refreshInstalled();
    expect(w.find(".sec-count").exists()).toBe(false);
  });
});
