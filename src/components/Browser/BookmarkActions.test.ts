// @vitest-environment jsdom
import { it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import BookmarkActions from "./BookmarkActions.vue";
it("右键移动菜单列出嵌套文件夹并允许移回收藏栏", async () => {
  const bookmark = { id: "a", title: "A", url: "https://a.com", folders: ["工具"], added_at: 1 };
  const w = mount(BookmarkActions, { props: { bookmark, bookmarks: [bookmark, { ...bookmark, id: "b", folders: ["工作", "参考"] }], x: 20, y: 30 }, global: { stubs: { teleport: true } } });
  try {
    await w.findAll("button")[1].trigger("click");
    expect(w.text()).toContain("工作 / 参考");
    const root = w.findAll("button").find(b => b.text().includes("收藏栏"))!;
    await root.trigger("click");
    expect(w.emitted("move")?.[0]).toEqual(["a", []]);
    expect(w.emitted("close")).toHaveLength(1);
  } finally { w.unmount(); }
});
