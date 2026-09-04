import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginEntry, InstalledPlugin, SourceInfo } from "../types/marketplace";

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

vi.mock("../api/marketplace", () => ({ marketplaceApi: api }));

import { useMarketplace } from "./useMarketplace";

const catalogEntry: PluginEntry[] = [
  {
    name: "code-review", displayName: "Code Review", description: "官方代码审查",
    version: "1.0.0", versionId: "v1.0.0", sourceId: "claude-plugins-official",
    marketName: "claude-plugins-official", category: "cat-code", homepage: "", repository: "",
    availability: "available", unsupported: [], isFeatured: false,
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

async function seed(over: {
  sources?: SourceInfo[];
  catalog?: PluginEntry[];
  installed?: InstalledPlugin[];
}) {
  api.listMarketplaceSources.mockResolvedValue(over.sources ?? []);
  api.fetchMarketplace.mockResolvedValue(over.catalog ?? []);
  api.listInstalledPlugins.mockResolvedValue(over.installed ?? []);
  const m = useMarketplace();
  await m.fetchSources();
  await m.fetchPlugins();
  await m.refreshInstalled();
  return m;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMarketplace 已装但不在目录的插件合成", () => {
  it("local 市场插件合成为列表条目，字段取自已装信息", async () => {
    const m = await seed({
      sources: [{ id: "claude-plugins-official", name: "官方", repo: "o/r", enabled: true }],
      catalog: catalogEntry,
      installed: installedLocal,
    });

    // 2 条 local 合成 + 1 条目录条目，无重复。
    expect(m.allEntries.value).toHaveLength(3);
    const local = m.allEntries.value.filter((p) => p.sourceId === "local");
    expect(local).toHaveLength(2);
    expect(local[0]).toMatchObject({
      name: "rust-backend",
      displayName: "Rust 后端质量",
      description: "Rust 工程质量插件",
      version: "0.1.2",
      versionId: "0.1.2",
      marketName: "local",
      availability: "available",
      unsupported: [],
    });
    // 目录条目原样保留，不参与合成。
    expect(m.allEntries.value.some((p) => p.name === "code-review" && p.sourceId === "claude-plugins-official")).toBe(true);
  });

  it("目录中已有的已装插件不重复合成（continue 臂）", async () => {
    const m = await seed({
      sources: [{ id: "claude-plugins-official", name: "官方", repo: "o/r", enabled: true }],
      catalog: catalogEntry,
      installed: [
        ...installedLocal,
        // 与目录条目同源同名的已装插件 → 应被 inCatalog 跳过。
        {
          name: "code-review", market: "claude-plugins-official", version: "1.0.0", versionId: "v1.0.0",
          displayName: "Code Review", description: "官方代码审查", author: "",
          path: "C:\\cache\\claude-plugins-official\\code-review\\v1.0.0", installedAt: 3, enabled: true,
        },
      ],
    });

    expect(m.allEntries.value.filter((p) => p.name === "code-review")).toHaveLength(1);
    expect(m.allEntries.value).toHaveLength(3);
  });

  it("禁用源的已装插件也合成（sourceId=market，徽标可辨）", async () => {
    // 目录只有官方源；已装里有社区源插件（源被禁用后目录里不再有它）。
    const m = await seed({
      sources: [{ id: "claude-plugins-official", name: "官方", repo: "o/r", enabled: true }],
      catalog: catalogEntry,
      installed: [
        {
          name: "community-tool", market: "claude-community", version: "2.0.0", versionId: "2.0.0",
          displayName: "Community Tool", description: "社区工具", author: "",
          path: "/home/x", installedAt: 4, enabled: true,
        },
      ],
    });

    const entry = m.allEntries.value.find((p) => p.name === "community-tool");
    expect(entry).toMatchObject({ sourceId: "claude-community", marketName: "claude-community" });
  });

  it("搜索能命中合成条目（name 与 description 两臂）", async () => {
    const m = await seed({
      sources: [{ id: "claude-plugins-official", name: "官方", repo: "o/r", enabled: true }],
      catalog: catalogEntry,
      installed: installedLocal,
    });

    m.searchQuery.value = "Rust";
    expect(m.filteredPlugins.value.map((p) => p.name)).toContain("rust-backend");
    m.searchQuery.value = "质量";
    expect(m.filteredPlugins.value.map((p) => p.name)).toEqual(["rust-backend", "ts-quality"]);
    m.searchQuery.value = "";
    expect(m.filteredPlugins.value).toHaveLength(3);
  });
});

describe("useMarketplace 主区面板开关", () => {
  it("open/close/toggle 切换 panelOpen（迁出设置页后的一级视图语义）", async () => {
    const m = useMarketplace();
    m.closePanel();
    expect(m.panelOpen.value).toBe(false);
    m.openPanel();
    expect(m.panelOpen.value).toBe(true);
    m.togglePanel();
    expect(m.panelOpen.value).toBe(false);
    m.togglePanel();
    expect(m.panelOpen.value).toBe(true);
    m.closePanel();
    expect(m.panelOpen.value).toBe(false);
  });
});

describe("useMarketplace 精选推荐", () => {
  it("featuredPlugins 只收 isFeatured 且可用的条目，合成条目恒不入选", async () => {
    const m = await seed({
      sources: [{ id: "claude-plugins-official", name: "官方", repo: "o/r", enabled: true }],
      catalog: [
        { ...catalogEntry[0], isFeatured: true },
        {
          name: "broken", displayName: "Broken", description: "不可用",
          version: "", versionId: "", sourceId: "claude-plugins-official",
          marketName: "claude-plugins-official", category: "", homepage: "", repository: "",
          availability: "unavailable", unsupported: [], isFeatured: true,
        },
      ],
      installed: installedLocal,
    });

    expect(m.featuredPlugins.value.map((p) => p.name)).toEqual(["code-review"]);
  });
});
