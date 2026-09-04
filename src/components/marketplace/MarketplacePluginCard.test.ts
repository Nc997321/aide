// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import type { PluginEntry } from "../../types/marketplace";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

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

import MarketplacePluginCard from "./MarketplacePluginCard.vue";

function entry(sourceId: string): PluginEntry {
  return {
    name: "p", displayName: "P", description: "d", version: "1.0.0", versionId: "1.0.0",
    sourceId, marketName: sourceId, category: "", homepage: "", repository: "",
    availability: "available", unsupported: [], isFeatured: false,
  };
}

function mountCard(sourceId: string) {
  return mount(MarketplacePluginCard, {
    props: { entry: entry(sourceId) },
    global: {
      directives: { tooltip: {} },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MarketplacePluginCard 来源徽标", () => {
  it("local 源显示「本地」+ local 徽标类", () => {
    const w = mountCard("local");
    expect(w.text()).toContain("本地");
    expect(w.find(".badge").classes()).toContain("local");
  });

  it("官方源显示「官方」+official 徽标类", () => {
    const w = mountCard("claude-plugins-official");
    expect(w.text()).toContain("官方");
    expect(w.find(".badge").classes()).toContain("official");
  });

  it("社区源显示「社区」+community 徽标类", () => {
    const w = mountCard("claude-community");
    expect(w.text()).toContain("社区");
    expect(w.find(".badge").classes()).toContain("community");
  });

  it("未知源回退显示原始 sourceId +local 徽标类（default 臂）", () => {
    const w = mountCard("other-market");
    expect(w.text()).toContain("other-market");
    expect(w.find(".badge").classes()).toContain("local");
  });
});

describe("MarketplacePluginCard 图标", () => {
  it("有 icon（data URL）→ 渲染 img", () => {
    const w = mount(MarketplacePluginCard, {
      props: { entry: { ...entry("local"), icon: "data:image/png;base64,AAAA" } },
      global: { directives: { tooltip: {} } },
    });
    const img = w.find("img.picon");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe("data:image/png;base64,AAAA");
    expect(w.find(".picon-placeholder").exists()).toBe(false);
  });

  it("无 icon → 首字母占位（displayName 第一个英文字母大写）", () => {
    const w = mount(MarketplacePluginCard, {
      props: { entry: { ...entry("local"), displayName: "rust Backend" } },
      global: { directives: { tooltip: {} } },
    });
    expect(w.find("img.picon").exists()).toBe(false);
    expect(w.find(".picon-placeholder").text()).toBe("R");
  });

  it("featured 变体：纵向卡片 + 底部操作区", () => {
    const w = mount(MarketplacePluginCard, {
      props: { entry: entry("claude-plugins-official"), variant: "featured" },
      global: { directives: { tooltip: {} } },
    });
    expect(w.find(".card").classes()).toContain("featured");
    expect(w.find(".f-head").exists()).toBe(true);
    expect(w.find(".f-foot").exists()).toBe(true);
  });
});
