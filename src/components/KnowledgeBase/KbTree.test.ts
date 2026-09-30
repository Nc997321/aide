// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, enableAutoUnmount } from "@vue/test-utils";
import KbTree from "./KbTree.vue";
// 相对导入而非 `@/`：测试文件被 tsconfig exclude，编辑器会为它们建推断项目，
// 那里不套 tsconfig 的 paths——用 `@/` 会满屏 "Cannot find module"（假的）。
// 同目录的 PermissionDialog.test.ts 也是这个写法。
import { useContextMenu } from "../../composables/useContextMenu";
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
      busy: false,
      collapsed: new Set<string>(),
      ...over,
    },
    global: { stubs: { Icon: true } },
  });
}

// ⋯ 菜单走应用统一的 ContextMenu 单例（Teleport 到 body + fixed），不再是组件 DOM 的
// 一部分。所以断言落在**菜单状态**上——那才是这个组件真正的产物。
const { items: menuItems, hide: hideMenu } = useContextMenu();
afterEach(() => hideMenu());

const menuLabels = () => menuItems.value.filter((i) => !i.separator).map((i) => i.label);

/** 执行菜单里的某一项并等一次 tick——动作本身是同步的，不 tick 的话 DOM 还是旧的。 */
async function pickMenuItem(w: ReturnType<typeof mountTree>, label: string): Promise<void> {
  const hit = menuItems.value.find((i) => i.label === label);
  if (!hit) throw new Error(`菜单里没有「${label}」：${menuLabels().join(" / ")}`);
  hit.action?.();
  await w.vm.$nextTick();
}

/** 点开某行的 ⋯，再执行菜单里那一项——走的都是真事件处理。 */
async function useMenuItem(
  w: ReturnType<typeof mountTree>,
  nodeId: string,
  label: string,
): Promise<void> {
  await w.find(`[data-kb-node='${nodeId}'] [data-kb-more]`).trigger("click");
  const hit = menuItems.value.find((i) => i.label === label);
  if (!hit) throw new Error(`菜单里没有「${label}」：${menuLabels().join(" / ")}`);
  hit.action?.();
  await w.vm.$nextTick();
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

  it("折叠箭头只在「文件夹且有子节点」时渲染——空文件夹给个按不动的箭头是骗人", () => {
    const w = mountTree();
    expect(w.find("[data-kb-node='f'] [data-kb-caret]").exists()).toBe(true); // 有子节点
    expect(w.find("[data-kb-node='g'] [data-kb-caret]").exists()).toBe(false); // 空文件夹
    expect(w.find("[data-kb-node='a'] [data-kb-caret]").exists()).toBe(false); // 文档
  });

  it("空文件夹带「空」标记，有子节点的文件夹没有", () => {
    const w = mountTree();
    expect(w.find("[data-kb-node='g'] [data-kb-empty]").exists()).toBe(true);
    expect(w.find("[data-kb-node='f'] [data-kb-empty]").exists()).toBe(false);
  });
});

describe("KbTree 的 ⋯ 菜单", () => {
  it("文件夹与文档的 ⋯ 菜单一致：都是「对这个节点」的操作（新建有自己的入口）", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-more]").trigger("click");
    expect(menuLabels()).toEqual(["重命名", "移动到…", "删除"]);

    await w.find("[data-kb-node='a'] [data-kb-more]").trigger("click");
    expect(menuLabels()).toEqual(["重命名", "移动到…", "删除"]);
  });

  it("删除是危险项（红色）", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='a'] [data-kb-more]").trigger("click");
    expect(menuItems.value.find((i) => i.label === "删除")?.danger).toBe(true);
  });

  it("重命名走内联输入：Enter 提交并发 patch（只带 title，不动父级）", async () => {
    const w = mountTree();
    await useMenuItem(w, "f", "重命名");
    await w.find("[data-kb-rename]").setValue("新名字");
    await w.find("[data-kb-rename]").trigger("keydown.enter");
    expect(w.emitted("patch")?.[0]).toEqual(["f", { title: "新名字" }]);
  });

  it("重命名 Esc 取消，不发 patch", async () => {
    const w = mountTree();
    await useMenuItem(w, "f", "重命名");
    await w.find("[data-kb-rename]").trigger("keydown.esc");
    expect(w.emitted("patch")).toBeFalsy();
    expect(w.find("[data-kb-rename]").exists()).toBe(false);
  });

  it("删除发 remove", async () => {
    const w = mountTree();
    await useMenuItem(w, "a", "删除");
    expect(w.emitted("remove")?.[0]).toEqual(["a"]);
  });

  it("移动到… 把菜单换成目标列表：根目录可选，自己与自己的子树置灰", async () => {
    const w = mountTree();
    await useMenuItem(w, "f", "移动到…");
    const byLabel = new Map(menuItems.value.map((i) => [i.label.trim(), i]));
    // 自己（f）与自己的子树（g）都必须**在列表里**且禁用——置灰不隐藏
    expect(byLabel.get("f")?.disabled).toBe(true);
    expect(byLabel.get("g")?.disabled).toBe(true);
    expect(byLabel.get("根目录")?.disabled).toBeUndefined();
  });

  it("移动到… 选中目标后发 patch.parentId", async () => {
    const w = mountTree();
    await useMenuItem(w, "a", "移动到…");
    menuItems.value.find((i) => i.label === "根目录")?.action?.();
    expect(w.emitted("patch")?.[0]).toEqual(["a", { parentId: null }]);
  });
});

describe("KbTree 的新建", () => {
  it("＋ 开的是「新建文件夹 / 新建文档 / 上传文件…」", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-add]").trigger("click");
    expect(menuLabels()).toEqual(["新建文件夹", "新建文档", "上传文件…"]);
  });

  it("上传文件… 点开隐藏的文件选择器（上传与新建同一个入口）", async () => {
    const w = mountTree();
    const input = w.find<HTMLInputElement>("[data-kb-file]");
    const opened = vi.spyOn(input.element, "click");

    await w.find("[data-kb-node='f'] [data-kb-add]").trigger("click");
    await pickMenuItem(w, "上传文件…");

    expect(opened).toHaveBeenCalled();
  });

  it("选中文件后发 upload（带父节点 id），并清掉 input 的值", async () => {
    const w = mountTree();
    const input = w.find<HTMLInputElement>("[data-kb-file]");
    // jsdom 里 files 是只读的，用 defineProperty 造一个「用户选了文件」的现场
    const file = new File(["x"], "复盘.html", { type: "text/html" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });

    await w.find("[data-kb-node='f'] [data-kb-add]").trigger("click");
    await pickMenuItem(w, "上传文件…");
    await input.trigger("change");

    expect(w.emitted("upload")?.[0]).toEqual(["f", file]);
    // 不清的话，同一个文件连选两次不会再触发 change
    expect(input.element.value).toBe("");
  });

  it("在文件夹行点「新建文档」→ create 带该文件夹 id 与 doc 类型", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-add]").trigger("click");
    await pickMenuItem(w, "新建文档");
    await w.find("[data-kb-new]").setValue("新文档");
    await w.find("[data-kb-new]").trigger("keydown.enter");
    expect(w.emitted("create")?.[0]).toEqual(["f", "doc", "新文档"]);
  });

  it("在文件夹行点「新建文件夹」→ create 带 folder 类型", async () => {
    const w = mountTree();
    await w.find("[data-kb-node='f'] [data-kb-add]").trigger("click");
    await pickMenuItem(w, "新建文件夹");
    await w.find("[data-kb-new]").setValue("新文件夹");
    await w.find("[data-kb-new]").trigger("keydown.enter");
    expect(w.emitted("create")?.[0]).toEqual(["f", "folder", "新文件夹"]);
  });

  it("★ 根目录也能建文件夹：openCreateMenu(…, null) 选文件夹 → create 的 parentId 是 null", async () => {
    // 这条钉的是一个真实缺口：早先两个 + 都写死新建文档，「新建子文件夹」只藏在
    // ⋯ 菜单里，于是**根目录根本建不出文件夹**——而这是知识库的核心能力。
    const w = mountTree();
    const btn = w.find("[data-kb-node='f'] [data-kb-add]").element;
    (w.vm as unknown as { openCreateMenu: (e: unknown, p: string | null) => void }).openCreateMenu(
      { currentTarget: btn } as unknown as MouseEvent,
      null,
    );
    await w.vm.$nextTick();
    await pickMenuItem(w, "新建文件夹");
    await w.find("[data-kb-new]").setValue("顶层文件夹");
    await w.find("[data-kb-new]").trigger("keydown.enter");
    expect(w.emitted("create")?.[0]).toEqual([null, "folder", "顶层文件夹"]);
  });
});
