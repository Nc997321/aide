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

import SidebarBottomDock from "./SidebarBottomDock.vue";
import { useMarketplace } from "../composables/useMarketplace";
import { useMemoryObservatory } from "../composables/useMemoryObservatory";
import { useKnowledgeBase } from "../composables/useKnowledgeBase";

function mountDock() {
  return mount(SidebarBottomDock, {
    global: { directives: { tooltip: {} } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SidebarBottomDock 侧栏底部固定入口区", () => {
  it("渲染「插件」「记忆观测台」「知识库」三行；点击插件行切换主区面板开关", async () => {
    const m = useMarketplace();
    m.closePanel();
    const w = mountDock();
    const rows = w.findAll(".dock-row");
    expect(rows.length).toBe(3);
    expect(w.text()).toContain("插件");
    expect(w.text()).toContain("记忆观测台");
    expect(w.text()).toContain("知识库");
    // 面板关闭 → 无选中态
    expect(rows[0].classes()).not.toContain("on");

    await rows[0].trigger("click");
    expect(m.panelOpen.value).toBe(true);
    await w.vm.$nextTick();
    expect(w.findAll(".dock-row")[0].classes()).toContain("on");

    await w.findAll(".dock-row")[0].trigger("click");
    expect(m.panelOpen.value).toBe(false);
  });

  it("知识库行切换知识库面板；与插件/观测台各自独立的模块级状态", async () => {
    const kb = useKnowledgeBase();
    const m = useMarketplace();
    kb.closePanel();
    m.closePanel();
    const w = mountDock();
    const rows = w.findAll(".dock-row");

    await rows[2].trigger("click");
    expect(kb.panelOpen.value).toBe(true);
    // 开知识库不该连带打开插件面板（互斥由 App.vue 的 watch 负责，组件层只管自己）
    expect(m.panelOpen.value).toBe(false);
    await w.vm.$nextTick();
    expect(w.findAll(".dock-row")[2].classes()).toContain("on");

    await w.findAll(".dock-row")[2].trigger("click");
    expect(kb.panelOpen.value).toBe(false);
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
    const w = mountDock();
    expect(w.find(".dock-count").text()).toBe("1");

    api.listInstalledPlugins.mockResolvedValue([]);
    await m.refreshInstalled();
    expect(w.find(".dock-count").exists()).toBe(false);
  });

  it("记忆观测台行走主区面板开关（与插件同范式，不再向上冒泡事件）", async () => {
    const m = useMarketplace();
    const mo = useMemoryObservatory();
    mo.closePanel();
    m.closePanel();
    const w = mountDock();

    await w.findAll(".dock-row")[1].trigger("click");
    expect(mo.panelOpen.value).toBe(true);
    await w.vm.$nextTick();
    expect(w.findAll(".dock-row")[1].classes()).toContain("on");

    await w.findAll(".dock-row")[1].trigger("click");
    expect(mo.panelOpen.value).toBe(false);
  });
});
