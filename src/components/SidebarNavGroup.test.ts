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
vi.mock("../api/marketplace", () => ({ marketplaceApi: api }));

import SidebarNavGroup from "./SidebarNavGroup.vue";
import { useMarketplace } from "../composables/useMarketplace";
import { useMemoryObservatory } from "../composables/useMemoryObservatory";
import { useKnowledgeBase } from "../composables/useKnowledgeBase";
import { useContextMenu } from "../composables/useContextMenu";
import type { SourceInfo } from "../api/marketplace";

/** 行序（与模板同序）：0 新增会话 / 1 插件 / 2 记忆观测台 / 3 知识库 */
const ROW = { NEW_SESSION: 0, PLUGIN: 1, OBSERVATORY: 2, KNOWLEDGE_BASE: 3 } as const;

function mountNavGroup() {
  return mount(SidebarNavGroup, {
    global: { directives: { tooltip: {} } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SidebarNavGroup 侧栏顶部导航组", () => {
  it("渲染「新增会话」「插件」「记忆观测台」「知识库」四行；点击插件行切换主区面板开关", async () => {
    const m = useMarketplace();
    m.closePanel();
    const w = mountNavGroup();
    const rows = w.findAll(".nav-row");
    expect(rows.length).toBe(4);
    expect(w.text()).toContain("新增会话");
    expect(w.text()).toContain("插件");
    expect(w.text()).toContain("记忆观测台");
    expect(w.text()).toContain("知识库");
    // 浏览器入口 2026-09-20 搬去右栏 rail（它是右栏 tab，不再是主区一级视图）——
    // 挡在这里，免得有人顺手往侧栏加回去。
    expect(w.text()).not.toContain("浏览器");
    // 面板关闭 → 无选中态
    expect(rows[ROW.PLUGIN].classes()).not.toContain("on");

    await rows[ROW.PLUGIN].trigger("click");
    expect(m.panelOpen.value).toBe(true);
    await w.vm.$nextTick();
    expect(w.findAll(".nav-row")[ROW.PLUGIN].classes()).toContain("on");

    await w.findAll(".nav-row")[ROW.PLUGIN].trigger("click");
    expect(m.panelOpen.value).toBe(false);
  });

  it("「新增会话」行 emit new-session——本组件不经手会话状态，创建归父级（Ctrl+N 同一入口）", async () => {
    const w = mountNavGroup();
    await w.findAll(".nav-row")[ROW.NEW_SESSION].trigger("click");
    expect(w.emitted("new-session")).toHaveLength(1);
  });

  it("知识库行切换知识库面板；与插件/观测台各自独立的模块级状态", async () => {
    const kb = useKnowledgeBase();
    const m = useMarketplace();
    kb.closePanel();
    m.closePanel();
    const w = mountNavGroup();
    const rows = w.findAll(".nav-row");

    await rows[ROW.KNOWLEDGE_BASE].trigger("click");
    expect(kb.panelOpen.value).toBe(true);
    // 开知识库不该连带打开插件面板（互斥由 App.vue 的 watch 负责，组件层只管自己）
    expect(m.panelOpen.value).toBe(false);
    await w.vm.$nextTick();
    expect(w.findAll(".nav-row")[ROW.KNOWLEDGE_BASE].classes()).toContain("on");

    await w.findAll(".nav-row")[ROW.KNOWLEDGE_BASE].trigger("click");
    expect(kb.panelOpen.value).toBe(false);
  });

  it("插件行右键出市场菜单；「刷新全部市场源」只刷 enabled 的源", async () => {
    api.listMarketplaceSources.mockResolvedValue([
      {
        id: "s1", name: "源一", enabled: true, order: 0,
        url: "https://example.com/a.json", lastFetchedAt: null, pluginCount: 0,
      },
      {
        id: "s2", name: "源二", enabled: false, order: 1,
        url: "https://example.com/b.json", lastFetchedAt: null, pluginCount: 0,
      },
    ]);
    const m = useMarketplace();
    await m.fetchSources();

    const menu = useContextMenu();
    const w = mountNavGroup();
    await w.findAll(".nav-row")[ROW.PLUGIN].trigger("contextmenu");
    expect(menu.visible.value).toBe(true);
    expect(menu.items.value.map((i) => i.label)).toEqual(["打开插件市场", "刷新全部市场源"]);

    menu.items.value[1]?.action?.();
    expect(api.refreshMarketplace).toHaveBeenCalledWith("s1");
    expect(api.refreshMarketplace).not.toHaveBeenCalledWith("s2");
  });

  it("插件行计数 = 已安装插件数（0 时不占位）", async () => {
    api.listInstalledPlugins.mockResolvedValue([
      {
        name: "a", market: "m", version: "1", versionId: "1", displayName: "A",
        description: "", author: "", path: "/x", installedAt: 1, enabled: true,
      },
    ]);
    const m = useMarketplace();
    await m.refreshInstalled();
    const w = mountNavGroup();
    expect(w.find(".nav-count").text()).toBe("1");

    api.listInstalledPlugins.mockResolvedValue([]);
    await m.refreshInstalled();
    expect(w.find(".nav-count").exists()).toBe(false);
  });

  it("记忆观测台行走主区面板开关（与插件同范式，不再向上冒泡事件）", async () => {
    const m = useMarketplace();
    const mo = useMemoryObservatory();
    mo.closePanel();
    m.closePanel();
    const w = mountNavGroup();

    await w.findAll(".nav-row")[ROW.OBSERVATORY].trigger("click");
    expect(mo.panelOpen.value).toBe(true);
    await w.vm.$nextTick();
    expect(w.findAll(".nav-row")[ROW.OBSERVATORY].classes()).toContain("on");

    await w.findAll(".nav-row")[ROW.OBSERVATORY].trigger("click");
    expect(mo.panelOpen.value).toBe(false);
  });
});
