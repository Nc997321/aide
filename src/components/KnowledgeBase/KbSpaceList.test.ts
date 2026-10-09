// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import KbSpaceList from "./KbSpaceList.vue";
// 相对导入而非 `@/`：测试文件被 tsconfig exclude，编辑器会为它们建推断项目，
// 那里不套 tsconfig 的 paths——用 `@/` 会满屏 "Cannot find module"（假的）。
import { useContextMenu } from "../../composables/useContextMenu";
import type { KbSpace } from "./kbClient";

// 内存备忘：带全局监听的组件测试必须 enableAutoUnmount，否则残留监听器吞后续事件
enableAutoUnmount(afterEach);

const SPACES: KbSpace[] = [
  { id: "s1", key: "eng", name: "工程手册", description: null, visibility: "internal", role: "owner" },
  { id: "s2", key: "prod", name: "产品档案", description: null, visibility: "private", role: "editor" },
];

function mountList() {
  return mount(KbSpaceList, {
    props: { spaces: SPACES, activeId: "s1", busy: false },
    global: { stubs: { Icon: true } },
  });
}

// ⋯ 菜单走 ContextMenu 单例（Teleport 到 body + fixed），不是组件 DOM 的一部分
const { items: menuItems, hide: hideMenu } = useContextMenu();

afterEach(() => hideMenu());

/** 点开某行的 ⋯，再执行菜单里那一项——走的都是真事件处理。 */
async function useMenuItem(w: ReturnType<typeof mountList>, spaceId: string, label: string) {
  await w.find(`[data-space='${spaceId}'] [data-kb-more]`).trigger("click");
  const hit = menuItems.value.find((i) => i.label === label);
  if (!hit) throw new Error(`菜单里没有「${label}」`);
  hit.action?.();
  await w.vm.$nextTick();
}

describe("KbSpaceList", () => {
  it("每行显示名称与角色", () => {
    const w = mountList();
    expect(w.text()).toContain("工程手册");
    expect(w.text()).toContain("owner");
    expect(w.text()).toContain("产品档案");
    expect(w.text()).toContain("editor");
  });

  it("点行发 select", async () => {
    const w = mountList();
    await w.find("[data-space='s2'] [data-space-label]").trigger("click");
    expect(w.emitted("select")?.[0]).toEqual(["s2"]);
  });

  it("⋯ 只给一个「重命名」（评审只勾了这一项）", async () => {
    const w = mountList();
    await w.find("[data-space='s1'] [data-kb-more]").trigger("click");
    expect(menuItems.value.filter((i) => !i.separator).map((i) => i.label)).toEqual(["重命名"]);
  });

  it("重命名走内联输入：Enter 提交并发 rename", async () => {
    const w = mountList();
    await useMenuItem(w, "s1", "重命名");
    await w.find("[data-space-rename]").setValue("工程手册（新）");
    await w.find("[data-space-rename]").trigger("keydown.enter");
    expect(w.emitted("rename")?.[0]).toEqual(["s1", "工程手册（新）"]);
  });

  it("重命名 Esc 取消，不发 rename", async () => {
    const w = mountList();
    await useMenuItem(w, "s1", "重命名");
    await w.find("[data-space-rename]").trigger("keydown.esc");
    expect(w.emitted("rename")).toBeFalsy();
    expect(w.find("[data-space-rename]").exists()).toBe(false);
  });
});
