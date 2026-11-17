// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
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

const packsApi = vi.hoisted(() => ({ list: vi.fn(), install: vi.fn(), uninstall: vi.fn() }));
vi.mock("@aide/sdk/api/lspPacks", () => ({ lspPacksApi: packsApi }));
const sdkApi = vi.hoisted(() => ({ lspDetectLanguages: vi.fn() }));
vi.mock("../../api", async (orig) => ({ ...(await orig<object>()), api: sdkApi }));
const apps = vi.hoisted(() => ({
  marketList: vi.fn(), marketInstall: vi.fn(), marketUninstall: vi.fn(),
  setEnabled: vi.fn(), uninstall: vi.fn(),
}));
vi.mock("@aide/sdk/api/apps", () => ({ appsApi: apps }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../../composables/useModal", () => ({ useModal: () => ({ confirm }) }));

import MarketplaceTab from "./MarketplaceTab.vue";

// 市场状态是模块级单例：上一个用例挂着的组件会继续监听（如 requestedCategory）并抢先消费
enableAutoUnmount(afterEach);
import { useMarketplace } from "../../composables/useMarketplace";
import { __resetLanguagePacksForTest } from "../../composables/useLanguagePacks";

const tsPack = {
  id: "typescript", name: "TypeScript / JavaScript", server: "typescript-language-server", summary: "ts",
  langs: ["typescript", "javascript"], version: "5.3.0", method: "npm", installed: null, installing: false,
};
const pyPack = { ...tsPack, id: "python", name: "Python", server: "pyright", summary: "py", langs: ["python"] };

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

async function mountTab(props: { workspaceRoot?: string } = {}, section?: "apps") {
  const w = mount(MarketplaceTab, {
    props,
    global: {
      directives: { tooltip: {} },
      stubs: { Icon: { template: "<span class='icon-stub' />" } },
    },
  });
  await flushPromises();
  if (!section && w.find("button[aria-pressed='true']").text() === "Aide 应用") {
    await w.findAll(".market-sections button").find((button) => button.text() === "Agent 插件")!.trigger("click");
  }
  return w;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetLanguagePacksForTest();
  useMarketplace().searchQuery.value = "";
  apps.marketList.mockResolvedValue({ apps: [], catalogError: null });
  packsApi.list.mockResolvedValue([pyPack, tsPack]);
  sdkApi.lspDetectLanguages.mockResolvedValue([]);
  api.listMarketplaceSources.mockResolvedValue([
    { id: "claude-plugins-official", name: "官方", repo: "o/r", enabled: true },
  ]);
  api.fetchMarketplace.mockResolvedValue(catalogEntry);
  api.listInstalledPlugins.mockResolvedValue(installedLocal);
});

const counter = {
  id: "counter", name: "计数器", description: "记录计数", availableVersion: "0.1.0",
  installedVersion: null, localVersion: null, enabled: null, installed: false, canUpdate: false, shadowed: false,
};

it("默认打开 Aide 应用，安装后从 Host 刷新状态", async () => {
  apps.marketList.mockResolvedValueOnce({ apps: [counter], catalogError: null })
    .mockResolvedValueOnce({ apps: [{ ...counter, installed: true, installedVersion: "0.1.0" }], catalogError: null });
  apps.marketInstall.mockResolvedValue(undefined);
  const w = await mountTab({}, "apps");
  const install = w.find(".app-card button");
  expect(install.text()).toBe("安装");
  await install.trigger("click");
  await flushPromises();
  expect(apps.marketInstall).toHaveBeenCalledWith("counter", "0.1.0", null);
  expect(w.text()).toContain("已安装 0.1.0");
});

it("更新时向 Host 传入已安装版本并刷新版本", async () => {
  const installed = { ...counter, installed: true, installedVersion: "0.1.0", availableVersion: "0.2.0", canUpdate: true };
  apps.marketList.mockResolvedValueOnce({ apps: [installed], catalogError: null })
    .mockResolvedValueOnce({ apps: [{ ...installed, installedVersion: "0.2.0", canUpdate: false }], catalogError: null });
  apps.marketInstall.mockResolvedValue(undefined);
  const w = await mountTab({}, "apps");
  const update = w.find(".app-card button");
  expect(update.text()).toBe("更新到 0.2.0");
  await update.trigger("click");
  await flushPromises();
  expect(apps.marketInstall).toHaveBeenCalledWith("counter", "0.2.0", "0.1.0");
  expect(w.text()).toContain("已安装 0.2.0");
});

it("目录离线时仍能从当前 Host 卸载市场版", async () => {
  apps.marketList.mockResolvedValueOnce({
    apps: [{ ...counter, installed: true, installedVersion: "0.1.0", availableVersion: null, shadowed: true }],
    catalogError: "目录离线",
  });
  confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  apps.marketUninstall.mockResolvedValue(undefined);
  const w = await mountTab({}, "apps");
  expect(w.text()).toContain("目录离线");
  expect(w.text()).toContain("当前工作区的开发版优先显示");
  const uninstall = w.find(".app-card button");
  expect(uninstall.text()).toBe("卸载");
  await uninstall.trigger("click");
  await flushPromises();
  expect(apps.marketUninstall).not.toHaveBeenCalled();
  await uninstall.trigger("click");
  await flushPromises();
  expect(apps.marketUninstall).toHaveBeenCalledWith("counter", "0.1.0");
});

it("本地任务面板可以在市场禁用、重新启用并卸载", async () => {
  const task = {
    ...counter, id: "task-runner", name: "任务面板", installed: true, localVersion: "0.1.0",
    availableVersion: null, enabled: true,
  };
  apps.marketList.mockResolvedValueOnce({ apps: [task], catalogError: null })
    .mockResolvedValueOnce({ apps: [{ ...task, enabled: false }], catalogError: null })
    .mockResolvedValueOnce({ apps: [task], catalogError: null });
  apps.setEnabled.mockResolvedValue(undefined);
  apps.uninstall.mockResolvedValue(undefined);
  confirm.mockResolvedValue(true);
  const w = await mountTab({}, "apps");
  for (const label of ["禁用", "启用", "卸载"]) {
    const button = w.findAll(".app-card button").find((item) => item.text() === label)!;
    await button.trigger("click");
    await flushPromises();
  }
  expect(apps.setEnabled.mock.calls).toEqual([["task-runner", false], ["task-runner", true]]);
  expect(apps.uninstall).toHaveBeenCalledWith("task-runner");
  expect(apps.marketUninstall).not.toHaveBeenCalled();
  expect(w.find(".app-card").exists()).toBe(false);
});

describe("MarketplaceTab 头部关闭入口", () => {
  it("✕ 关闭面板（与记忆观测台同语义：主区切回聊天，不卸载会话）", async () => {
    const m = useMarketplace();
    m.openPanel();
    const w = await mountTab();
    await w.find(".mkt-close").trigger("click");
    expect(m.panelOpen.value).toBe(false);
  });
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

describe("MarketplaceTab 推荐视图（精选首页）", () => {
  async function mountWithFeatured() {
    api.fetchMarketplace.mockResolvedValue([
      { ...catalogEntry[0], isFeatured: true, icon: "data:image/png;base64,AAAA" },
    ]);
    // useMarketplace 的 searchQuery 是模块级状态、跨用例共享——前面的搜索用例会污染，先复位。
    useMarketplace().searchQuery.value = "";
    const w = await mountTab();
    return w;
  }

  it("有精选插件时出现「推荐」分类并默认选中，渲染 Hero + 精选网格", async () => {
    const w = await mountWithFeatured();

    const featuredTag = w.findAll(".ftag").find((t) => t.text().includes("推荐"));
    expect(featuredTag).toBeTruthy();
    expect(featuredTag!.classes()).toContain("active");
    expect(w.find(".hero").exists()).toBe(true);
    expect(w.text()).toContain("发现更多可能性");
    expect(w.text()).toContain("精选推荐");
    const cards = w.findAll(".featured-grid .card");
    expect(cards).toHaveLength(1);
    expect(cards[0].classes()).toContain("featured");
  });

  it("精选卡渲染图标 img（icon data URL 透传）", async () => {
    const w = await mountWithFeatured();
    const img = w.find(".featured-grid img.picon");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe("data:image/png;base64,AAAA");
  });

  it("推荐视图下搜索 → 回退普通列表（Hero 隐藏）", async () => {
    const w = await mountWithFeatured();
    await w.find("input").setValue("code");
    expect(w.find(".hero").exists()).toBe(false);
    expect(w.findAll(".plugin-list .card")).toHaveLength(1);
  });

  it("无精选插件 → 无「推荐」分类，默认仍在「全部」", async () => {
    const w = await mountTab();
    expect(w.findAll(".ftag").some((t) => t.text().includes("推荐"))).toBe(false);
    const allTag = w.findAll(".ftag").find((t) => t.text().includes("全部"));
    expect(allTag!.classes()).toContain("active");
  });
});

describe("MarketplaceTab「语言服务器」分类", () => {
  // 搜索词是模块级单例：前面的搜索用例会留下关键词，把语言包也过滤掉
  beforeEach(() => {
    useMarketplace().searchQuery.value = "";
  });

  it("有语言包时出现该分类；点进去列出语言包，当前项目在用的置顶并标出", async () => {
    sdkApi.lspDetectLanguages.mockResolvedValue(["typescript"]);
    const w = await mountTab({ workspaceRoot: "/ws" });
    const tag = w.findAll(".market-sections button").find((t) => t.text() === "语言服务器");
    expect(tag).toBeTruthy();
    await tag!.trigger("click");
    const names = w.findAll(".card .name").map((n) => n.text());
    expect(names).toEqual(["TypeScript / JavaScript", "Python"]);
    expect(w.findAll(".inuse")).toHaveLength(1);
  });

  it("推荐首页：当前项目在用但没装的语言包在精选上方提示", async () => {
    api.fetchMarketplace.mockResolvedValue([{ ...catalogEntry[0]!, isFeatured: true }]);
    sdkApi.lspDetectLanguages.mockResolvedValue(["python"]);
    const w = await mountTab({ workspaceRoot: "/ws" });
    expect(w.text()).toContain("为当前项目装上语言服务器");
    expect(w.findAll(".card .name").map((n) => n.text())).toContain("Python");
  });

  it("从「语言环境」面板打开（openPanel 带分类）：直接落到「语言服务器」，市场已开着也会跳过去", async () => {
    const m = useMarketplace();
    m.openPanel({ category: "langpacks" });
    const w = await mountTab();
    expect(w.find(".pack-intro").exists()).toBe(true);
    expect(m.requestedCategory.value).toBeNull();

    await w.findAll(".market-sections button").find((t) => t.text() === "Agent 插件")!.trigger("click");
    expect(w.find(".pack-intro").exists()).toBe(false);
    m.openPanel({ category: "langpacks" });
    await flushPromises();
    expect(w.find(".pack-intro").exists()).toBe(true);
  });
});
