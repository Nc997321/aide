// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const linkApi = vi.hoisted(() => ({
  kbLinks: vi.fn(async () => ({}) as Record<string, string[]>),
  setKbLinks: vi.fn(async (_id: string, _keys: string[]) => ({}) as Record<string, string[]>),
}));
vi.mock("@aide/sdk/api", () => ({
  api: new Proxy(linkApi, { get: (t, k: string) => (k in t ? (t as Record<string, unknown>)[k] : vi.fn(async () => undefined)) }),
}));

import KbLinkedProjects from "./KbLinkedProjects.vue";
import { useContextMenu } from "../../composables/useContextMenu";
import { useWorkspaces } from "../../composables/useWorkspaces";
import { __resetKbLinksForTest } from "../../composables/useKbLinks";

enableAutoUnmount(afterEach);
const { items: menuItems, hide: hideMenu } = useContextMenu();

const CRUMBS = [
  { id: "root", title: "研发" },
  { id: "near", title: "发布" },
];

beforeEach(() => {
  __resetKbLinksForTest();
  hideMenu();
  linkApi.kbLinks.mockReset().mockResolvedValue({});
  linkApi.setKbLinks.mockReset().mockResolvedValue({});
  useWorkspaces().workspaces.value = [
    { key: "ws-a", name: "/home/u/proj-a", missing: false },
    { key: "ws-b", name: "/home/u/proj-b", missing: false },
  ];
});

async function mountRow(table: Record<string, string[]>) {
  linkApi.kbLinks.mockResolvedValue(table);
  const w = mount(KbLinkedProjects, { props: { nodeId: "doc", crumbs: CRUMBS } });
  await flushPromises();
  return w;
}

describe("KbLinkedProjects", () => {
  it("没有任何关联：只有一个「＋ 关联项目」入口", async () => {
    const w = await mountRow({});
    expect(w.findAll(".kb-linked-chip")).toHaveLength(0);
    expect(w.find(".kb-linked-add").text()).toBe("＋ 关联项目");
  });

  it("自己关联的可摘（×），继承自祖先的淡色、注明来源、没有 ×", async () => {
    const w = await mountRow({ doc: ["ws-a"], near: ["ws-b"] });
    const chips = w.findAll(".kb-linked-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.text()).toContain("proj-a");
    expect(chips[0]!.find(".kb-linked-x").exists()).toBe(true);
    expect(chips[1]!.text()).toContain("proj-b（来自「发布」）");
    expect(chips[1]!.classes()).toContain("kb-linked-chip--inherited");
    expect(chips[1]!.find(".kb-linked-x").exists()).toBe(false);
  });

  it("关联到的工作区已经不在了：标成警示，不静默丢掉", async () => {
    const w = await mountRow({ doc: ["ws-gone"] });
    const chip = w.find(".kb-linked-chip");
    expect(chip.classes()).toContain("kb-linked-chip--missing");
    expect(chip.text()).toContain("已不在");
  });

  it("点 × 摘掉自己的关联：写回 Host，只剩其余的", async () => {
    const w = await mountRow({ doc: ["ws-a", "ws-b"] });
    await w.findAll(".kb-linked-x")[0]!.trigger("click");
    expect(linkApi.setKbLinks).toHaveBeenCalledWith("doc", ["ws-b"]);
  });

  it("点 ＋ 打开选择菜单：已关联的打勾，选一个就加上", async () => {
    const w = await mountRow({ doc: ["ws-a"] });
    await w.find(".kb-linked-add").trigger("click");
    expect(menuItems.value.map((i) => [i.label, i.icon])).toEqual([["proj-a", "✓"], ["proj-b", "○"]]);
    menuItems.value[1]!.action?.();
    expect(linkApi.setKbLinks).toHaveBeenCalledWith("doc", ["ws-a", "ws-b"]);
  });
});
