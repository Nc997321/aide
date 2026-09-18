// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import KbTree from "./KbTree.vue";
import type { KbDocumentSummary } from "./kbClient";

// 内存备忘：带全局监听的组件测试必须 enableAutoUnmount，否则残留监听器吞后续事件
enableAutoUnmount(afterEach);

function node(id: string, parentId: string | null, kind: "doc" | "folder"): KbDocumentSummary {
  return {
    id,
    parentId,
    kind,
    slug: id,
    title: id,
    versionNo: kind === "folder" ? 0 : 1,
    status: "draft",
    updatedAt: "2026-09-18T00:00:00Z",
  };
}

// f 下面挂着 a（文档）与 g（空文件夹）
const DOCS = [node("f", null, "folder"), node("a", "f", "doc"), node("g", "f", "folder")];

function mountTree(over: Partial<{ activeId: string | null; collapsed: Set<string> }> = {}) {
  return mount(KbTree, {
    props: {
      documents: DOCS,
      activeId: null,
      spaceId: "s1",
      busy: false,
      collapsed: new Set<string>(),
      ...over,
    },
    global: { stubs: { Icon: true } },
  });
}

/** 按文字取菜单项——不按下标取，菜单项的顺序不是契约，措辞才是。 */
function menuItem(w: ReturnType<typeof mountTree>, text: string) {
  const hit = w.findAll("[data-kb-menu] button").find((b) => b.text() === text);
  if (!hit) throw new Error(`菜单里没有「${text}」`);
  return hit;
}

describe("KbTree", () => {
  it("默认全展开：文件夹下的子节点都渲染", () => {
    expect(mountTree().findAll("[data-kb-node]").length).toBe(3);
  });

  it("折叠状态的读取：collapsed 里有的文件夹 → 子树不渲染，文件夹自己还在", () => {
    const w = mountTree({ collapsed: new Set(["f"]) });
    expect(w.findAll("[data-kb-node]").map((n) => n.attributes("data-kb-node"))).toEqual(["f"]);
  });

  it("点折叠箭头发 toggle（折叠状态由父层持有，组件是受控的）", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-caret]").trigger("click");
    expect(w.emitted("toggle")?.[0]).toEqual(["f"]);
  });

  it("点文档发 open，点文件夹不发", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='a'] [data-kb-label]").trigger("click");
    expect(w.emitted("open")?.[0]).toEqual(["a"]);

    await w.find("[data-kb-node='f'] [data-kb-label]").trigger("click");
    expect(w.emitted("open")).toHaveLength(1);
  });

  it("+ 只出现在文件夹行（文档是叶子，给它「新建子项」没意义）", () => {
    const w = mountTree();
    expect(w.find("[data-kb-node='f'] [data-kb-add]").exists()).toBe(true);
    expect(w.find("[data-kb-node='a'] [data-kb-add]").exists()).toBe(false);
  });

  it("文件夹的 ⋯ 菜单四项", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-more]").trigger("click");
    expect(w.findAll("[data-kb-menu] button").map((b) => b.text())).toEqual([
      "新建子文件夹",
      "重命名",
      "移动到…",
      "删除",
    ]);
  });

  it("文档的 ⋯ 菜单少「新建子文件夹」", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='a'] [data-kb-more]").trigger("click");
    expect(w.findAll("[data-kb-menu] button").map((b) => b.text())).toEqual([
      "重命名",
      "移动到…",
      "删除",
    ]);
  });

  it("空文件夹带「空」标记，有子节点的文件夹没有", () => {
    const w = mountTree();
    expect(w.find("[data-kb-node='g'] [data-kb-empty]").exists()).toBe(true);
    expect(w.find("[data-kb-node='f'] [data-kb-empty]").exists()).toBe(false);
  });

  it("重命名走内联输入：Enter 提交并发 patch（只带 title，不动父级）", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-more]").trigger("click");
    await menuItem(w, "重命名").trigger("click");
    await w.find("[data-kb-rename]").setValue("新名字");
    await w.find("[data-kb-rename]").trigger("keydown.enter");
    expect(w.emitted("patch")?.[0]).toEqual(["f", { title: "新名字" }]);
  });

  it("重命名 Esc 取消，不发 patch", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-more]").trigger("click");
    await menuItem(w, "重命名").trigger("click");
    await w.find("[data-kb-rename]").trigger("keydown.esc");
    expect(w.emitted("patch")).toBeFalsy();
    expect(w.find("[data-kb-rename]").exists()).toBe(false);
  });

  it("＋ 开内联输入，Enter 提交并发 create（带父 id、类型、标题）", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-add]").trigger("click");
    await w.find("[data-kb-new]").setValue("新文档");
    await w.find("[data-kb-new]").trigger("keydown.enter");
    expect(w.emitted("create")?.[0]).toEqual(["f", "doc", "新文档"]);
  });

  it("删除发 remove", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='a'] [data-kb-more]").trigger("click");
    await menuItem(w, "删除").trigger("click");
    expect(w.emitted("remove")?.[0]).toEqual(["a"]);
  });

  it("移动到… 的候选里，自己与自己的子树置灰（不是隐藏——隐藏会让人以为列表坏了）", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-more]").trigger("click");
    await menuItem(w, "移动到…").trigger("click");
    const opts = w.findAll("[data-kb-move] button");
    // 根目录 + f（自己）+ g（自己的子树），f 与 g 都必须存在且禁用
    const byText = new Map(opts.map((b) => [b.text().trim(), b]));
    expect(byText.has("f")).toBe(true);
    expect(byText.has("g")).toBe(true);
    expect(byText.get("f")!.attributes("disabled")).toBeDefined();
    expect(byText.get("g")!.attributes("disabled")).toBeDefined();
    // 「根目录」永远可选
    expect(byText.get("根目录")!.attributes("disabled")).toBeUndefined();
  });
});
