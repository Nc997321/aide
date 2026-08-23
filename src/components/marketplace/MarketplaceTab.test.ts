// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PluginEntry, InstalledPlugin } from "../../types/marketplace";

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

import MarketplaceTab from "./MarketplaceTab.vue";

const catalogEntry: PluginEntry[] = [
  {
    name: "code-review", displayName: "Code Review", description: "官方代码审查",
    version: "1.0.0", versionId: "v1.0.0", sourceId: "claude-plugins-official",
    marketName: "claude-plugins-official", category: "cat-code", homepage: "", repository: "",
    availability: "available", unsupported: [],
  },
];

const installedLocal: InstalledPlugin[] = [
  {
    name: "rust-backend", market: "local", version: "0.1.2", versionId: "0.1.2",
    displayName: "Rust 后端质量", description: "Rust 工程质量插件", author: "heaven",
    path: "C:/cache/local/rust-backend/0.1.2", installedAt: 1, enabled: true,
  },
  {
    name: "ts-quality", market: "local", version: "0.1.0", versionId: "0.1.0",
    displayName: "TS 质量", description: "TS 工程质量插件", author: "heaven",
    path: "C:/cache/local/ts-quality/0.1.0", installedAt: 2, enabled: true,
  },
];

async function mountTab() {
  const w = mount(MarketplaceTab, {
    global: {
      directives: { tooltip: {} },
      stubs: { Icon: { template: "<span class='icon-stub' />" } },
    },
  });
  await flushPromises();
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listMarketplaceSources.mockResolvedValue([
    { id: "claude-plugins-official", name: "官方", repo: "o/r", enabled: true },
  ]);
  api.fetchMarketplace.mockResolvedValue(catalogEntry);
  api.listInstalledPlugins.mockResolvedValue(installedLocal);
});

describe("MarketplaceTab 已安装视图补齐本地插件", () => {
  it("「已安装」分类出现且计数含 local 插件", async () => {
    const w = await mountTab();

    const installedTag = w.findAll(".ftag").find((t) => t.text().includes("已安装"));
    expect(installedTag).toBeTruthy();
    expect(installedTag!.text()).toContain("2");
  });

  it("「全部」计数含合成条目，列表中渲染 local 徽标卡片", async () => {
    const w = await mountTab();
    const allTag = w.findAll(".ftag").find((t) => t.text().includes("全部"));
    // 目录 1 + 本地 2 = 3
    expect(allTag!.text()).toContain("3");
    expect(w.text()).toContain("Rust 后端质量");
    expect(w.text()).toContain("本地");
  });

  it("切到「已安装」只显示已装插件（目录 + 本地）", async () => {
    const w = await mountTab();
    const installedTag = w.findAll(".ftag").find((t) => t.text().includes("已安装"))!;
    await installedTag.trigger("click");

    const cards = w.findAll(".plugin-list .card");
    expect(cards).toHaveLength(2);
    expect(w.text()).toContain("TS 质量");
    expect(w.text()).not.toContain("Code Review");
  });

  it("搜索命中本地插件（已安装视图内）", async () => {
    const w = await mountTab();
    const installedTag = w.findAll(".ftag").find((t) => t.text().includes("已安装"))!;
    await installedTag.trigger("click");

    await w.find("input").setValue("rust");
    const cards = w.findAll(".plugin-list .card");
    expect(cards).toHaveLength(1);
    expect(w.text()).toContain("Rust 后端质量");
  });
});
