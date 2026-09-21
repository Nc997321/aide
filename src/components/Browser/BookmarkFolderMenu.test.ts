// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";

import BookmarkFolderMenu from "./BookmarkFolderMenu.vue";
import { buildBookmarkBar, type BookmarkFolder } from "../../utils/browser";
import { overlayLayerOpen } from "../../directives/overlayLayer";
import type { Bookmark } from "../../composables/browser/useBrowserBookmarks";

const bm = (id: string, folders: string[] = []): Bookmark => ({
  id,
  title: id.toUpperCase(),
  url: `https://${id}.com/`,
  folders,
  added_at: 1,
});

/** 用真分组函数造出目录（手搓 BookmarkFolder 会跟 buildBookmarkBar 的形状约定漂移）。 */
function folderOf(name: string, rows: Bookmark[]): BookmarkFolder {
  const hit = buildBookmarkBar(rows).find((e) => e.kind === "folder" && e.folder.name === name);
  if (!hit || hit.kind !== "folder") throw new Error(`测试数据里没有目录 ${name}`);
  return hit.folder;
}

/** 挂载过的菜单。`overlayLayerOpen` 是**模块级**登记处，漏 unmount 会污染后面的用例。 */
let mounted: VueWrapper[] = [];

function mountMenu(
  folder: BookmarkFolder,
  favicons: Record<string, string | undefined> = {},
): VueWrapper {
  const w = mount(BookmarkFolderMenu, {
    props: { folder, anchor: { left: 20, top: 40 }, favicons },
    // 真组件 Teleport 到 body（背 `backdrop-filter` 的包含块），测试里内联渲染方便查 DOM。
    global: { stubs: { teleport: true } },
  });
  mounted.push(w);
  return w;
}

afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
});

describe("BookmarkFolderMenu", () => {
  it("列目录里的书签；子目录出一行小标题", () => {
    const folder = folderOf("工作", [bm("w1", ["工作"]), bm("z1", ["工作", "漳蒲"])]);
    const w = mountMenu(folder);

    expect(w.findAll(".bp-fmenu__item").map((n) => n.text())).toEqual(["W1", "Z1"]);
    expect(w.findAll(".bp-fmenu__group").map((n) => n.text())).toEqual(["漳蒲"]);
  });

  it("子项渲染站点真图标；查不到的渲染地球字形（不是空位）", () => {
    const folder = folderOf("工具", [bm("a", ["工具"]), bm("b", ["工具"])]);
    const w = mountMenu(folder, { "https://a.com/": "data:image/png;base64,AAA" });

    const items = w.findAll(".bp-fmenu__item");
    expect(items[0].find(".bp-fmenu__icon").attributes("src")).toBe("data:image/png;base64,AAA");
    expect(items[1].find(".bp-fmenu__glyph").exists()).toBe(true);
  });

  it("点子项 emit 出 URL（面板据此导航）", async () => {
    const w = mountMenu(folderOf("工具", [bm("a", ["工具"])]));
    await w.find(".bp-fmenu__item").trigger("click");
    expect(w.emitted("open")).toEqual([["https://a.com/"]]);
  });

  it("点遮罩关闭；菜单内部的点击不误关", async () => {
    const w = mountMenu(folderOf("工具", [bm("a", ["工具"])]));

    await w.find(".bp-fmenu").trigger("click");
    expect(w.emitted("close")).toBeUndefined();

    await w.find(".bp-fmenu-overlay").trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("Esc 关菜单并 preventDefault（消费约定：不拦的话权限弹窗会跟着响应）", async () => {
    const w = mountMenu(folderOf("工具", [bm("a", ["工具"])]));

    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    await w.vm.$nextTick();

    expect(w.emitted("close")).toHaveLength(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("其它键不关菜单（只认 Esc）", async () => {
    const w = mountMenu(folderOf("工具", [bm("a", ["工具"])]));

    const e = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    await w.vm.$nextTick();

    expect(w.emitted("close")).toBeUndefined();
  });

  it("在册即登记浮层、卸载即注销（原生视图据此让位，否则菜单被网页吃掉下半截）", async () => {
    // 这条是**物理约束**的回归：登记漏了菜单会被原生子视图盖住，且只有「洞」以上那一条可见。
    expect(overlayLayerOpen.value).toBe(false);

    const w = mount(BookmarkFolderMenu, {
      props: {
        folder: folderOf("工具", [bm("a", ["工具"])]),
        anchor: { left: 0, top: 0 },
        favicons: {},
      },
      global: { stubs: { teleport: true } },
    });
    await w.vm.$nextTick();
    expect(overlayLayerOpen.value).toBe(true);

    w.unmount();
    await w.vm.$nextTick();
    expect(overlayLayerOpen.value).toBe(false);
  });
});
