// @vitest-environment jsdom
//
// 回归：原生 WebView2 子视图浮在所有 HTML 之上（**不受 z-index 约束**，见 BrowserPanel.vue 顶部
// 「物理约束」），所以面板内的 HTML 浮层一开，原生视图必须让位——否则浮层只有「洞」以上那一条
// 可见，其余被网页整个吃掉（导入书签的文件选择器只剩标题 + 地址行，取消/确认按钮全不见）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, withDirectives } from "vue";

import { vOverlayLayer } from "../../directives/overlayLayer";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import BrowserPanel from "./BrowserPanel.vue";
import BookmarkFolderMenu from "./BookmarkFolderMenu.vue";
import { useRightPanel, __resetRightPanelForTest } from "../../composables/useRightPanel";

const VIEW_ID = "view-1";

/** 文件选择器桩：真组件会拉起 DirTreePicker（要 FS 命令）。
 *  形态与真组件一致——遮罩根元素 `v-if` 控制 + 挂 `v-overlay-layer`，因为 BrowserPanel 正是靠
 *  「有没有浮层登记」来决定原生视图让不让位，桩不挂指令就测不到那条链路。 */
const FilePickerStub = defineComponent({
  name: "FilePickerDialog",
  props: {
    visible: { type: Boolean, default: false },
    title: { type: String, default: "" },
    emptyError: { type: String, default: "" },
  },
  emits: ["update:visible", "confirm"],
  setup(props) {
    return () =>
      props.visible
        ? withDirectives(h("div", { class: "fp-stub" }), [[vOverlayLayer]])
        : null;
  },
});

const rect = {
  left: 100,
  top: 200,
  width: 800,
  height: 600,
  right: 900,
  bottom: 800,
  x: 100,
  y: 200,
  toJSON: () => ({}),
} as DOMRect;

/** 挂载过的面板：断言失败时 `unmount()` 到不了，留着的实例会接着响应 Singleton 的状态变化
 *  （它自己的 window listener 也没摘）→ 污染下一个用例的 invoke 记录。统一在 afterEach 收尸。 */
let mounted: VueWrapper[] = [];

function mountPanel(): VueWrapper {
  const w = mount(BrowserPanel, {
    global: {
      // 文件夹菜单真身 Teleport 到 body（躲开 `backdrop-filter` 的包含块）；测试里内联渲染。
      stubs: { FilePickerDialog: FilePickerStub, teleport: true },
      directives: { tooltip: () => {} },
    },
  });
  mounted.push(w);
  return w;
}

/** 走正常入口建出原生视图：地址栏输入 + 回车（首次导航才 create）。 */
async function openView(w: VueWrapper) {
  const addr = w.find(".bp-address");
  await addr.setValue("https://example.com");
  await addr.trigger("keydown.enter");
  await flushPromises();
}

/** 闭包里的调用实参（`toHaveBeenCalledWith` 对同一命令的多次调用会互相干扰，取最后一条判定）。 */
function lastArgsOf(cmd: string): unknown[] | null {
  const hit = invokeMock.mock.calls.filter((c) => c[0] === cmd).pop();
  return hit ? hit.slice(1) : null;
}

beforeEach(() => {
  invokeMock.mockReset();
  // jsdom 不做布局：不打桩的话 rectOf() 恒为 0×0，BrowserPanel 会拒绝建视图（"占位区未就绪"）。
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "browser_create") {
      return {
        id: VIEW_ID,
        nav: { state: "ready", url: "https://example.com/", title: "example" },
        can_go_back: false,
        can_go_forward: false,
        bounds: { x: 0, y: 0, w: 0, h: 0 },
        visible: true,
      };
    }
    if (cmd === "browser_bookmarks_list") return [];
    // 图标回**空表**（不是 undefined/空数组）：回错类型会静默变成"所有图标都没有"。
    if (cmd === "browser_favicons") return {};
    return undefined;
  });
  // 面板开合现在归 useRightPanel：select('browser') = 展开右栏并激活浏览器 tab。
  __resetRightPanelForTest();
  useRightPanel().select("browser");
});

afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetRightPanelForTest();
});

describe("BrowserPanel 浮层与原生视图的让位", () => {
  it("打开导入文件选择器 → 隐藏原生视图（否则弹窗被网页吃掉下半截）", async () => {
    const w = mountPanel();
    await openView(w);
    expect(invokeMock).toHaveBeenCalledWith(
      "browser_create",
      expect.objectContaining({ dto: expect.objectContaining({ url: expect.any(String) }) }),
    );

    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();

    expect(lastArgsOf("browser_set_visible")).toEqual([{ id: VIEW_ID, visible: false }]);
  });

  it("关掉文件选择器 → 原生视图回来（并重新贴合占位洞坐标）", async () => {
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();
    w.findComponent(FilePickerStub).vm.$emit("update:visible", false);
    await flushPromises();

    expect(lastArgsOf("browser_set_visible")).toEqual([{ id: VIEW_ID, visible: true }]);
    expect(lastArgsOf("browser_set_bounds")).toEqual([
      { id: VIEW_ID, bounds: { x: 100, y: 200, w: 800, h: 600 } },
    ]);
  });

  it("浮层开着时面板被关掉 → 再开面板不许把原生视图露出来", async () => {
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();
    useRightPanel().select("browser"); // 再点已激活的 tab = 折叠（浮层还开着）
    await flushPromises();
    useRightPanel().select("browser"); // 再展开
    await flushPromises();

    expect(lastArgsOf("browser_set_visible")).toEqual([{ id: VIEW_ID, visible: false }]);
  });
});

describe("收藏夹目录", () => {
  // 真机形状：顶层目录 → 二级目录，外加一条根级散条。
  const ROWS = [
    { id: "b1", title: "A 站", url: "https://a.com/", folders: ["工具"], added_at: 1 },
    { id: "b2", title: "Z 站", url: "https://z.com/", folders: ["工具", "漳蒲"], added_at: 2 },
    { id: "b3", title: "根级", url: "https://root.com/", folders: [], added_at: 3 },
  ];

  /** 让 `browser_bookmarks_list` 回这批数据、`browser_favicons` 回给定的图标表；其余命令沿用
   *  beforeEach 装好的桩（wrap 一层而不是重写整份实现，免得漏掉 `browser_create` 那条）。 */
  function seedBookmarks(favicons: Record<string, string> = {}) {
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "browser_bookmarks_list") return ROWS;
      if (cmd === "browser_favicons") return favicons;
      return base(cmd);
    });
  }

  it("顶层目录成为收藏条上的按钮，根级书签仍是散条", async () => {
    seedBookmarks();
    const w = mountPanel();
    await flushPromises();

    expect(w.findAll(".bp-bm-folder").map((n) => n.text())).toEqual(["工具"]);
    expect(w.findAll(".bp-bm-label").map((n) => n.text())).toEqual(["工具", "根级"]);
  });

  it("文件夹按钮用文件夹字形——不是 ▾，也不是书签那种真图标", async () => {
    // 「文件夹该有文件夹的图标」是标准做法；▾ 是上一版没有图标时的占位，Edge/Chrome 都没有。
    seedBookmarks();
    const w = mountPanel();
    await flushPromises();

    const btn = w.find(".bp-bm-folder");
    expect(btn.find(".bp-bm-glyph").exists()).toBe(true);
    expect(btn.find(".bp-bm-icon").exists()).toBe(false);
    expect(btn.text()).not.toContain("▾");
  });

  it("书签行渲染站点真图标", async () => {
    // 根级那条是 root.com（见 ROWS）——图标按 URL 给，不是按"第几条"。
    seedBookmarks({ "https://root.com/": "data:image/png;base64,ROOT" });
    const w = mountPanel();
    await flushPromises();

    const rows = w.findAll(".bp-bm:not(.bp-bm-folder)");
    expect(rows).toHaveLength(1);
    expect(rows[0].find(".bp-bm-icon").attributes("src")).toBe("data:image/png;base64,ROOT");
  });

  it("查不到图标 → 地球字形占位，不留空位", async () => {
    seedBookmarks({});
    const w = mountPanel();
    await flushPromises();

    const row = w.find(".bp-bm:not(.bp-bm-folder)");
    expect(row.find(".bp-bm-glyph").exists()).toBe(true);
    expect(row.find(".bp-bm-icon").exists()).toBe(false);
  });

  it("目录里的条目也带图标（下拉里查同一张表）", async () => {
    seedBookmarks({ "https://a.com/": "data:image/png;base64,AAA" });
    const w = mountPanel();
    await flushPromises();

    await w.find(".bp-bm-folder").trigger("click");
    await flushPromises();

    const items = w.findAll(".bp-fmenu__item");
    expect(items[0].find(".bp-fmenu__icon").attributes("src")).toBe("data:image/png;base64,AAA");
    // 「Z 站」没图标 → 地球字形。
    expect(items[1].find(".bp-fmenu__glyph").exists()).toBe(true);
  });

  it("点目录按钮展开下拉；开着时原生视图让位（否则菜单被网页吃掉下半截）", async () => {
    seedBookmarks();
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-folder").trigger("click");
    await flushPromises();

    const menu = w.findComponent(BookmarkFolderMenu);
    expect(menu.exists()).toBe(true);
    expect(menu.props("folder").name).toBe("工具");
    expect(lastArgsOf("browser_set_visible")).toEqual([{ id: VIEW_ID, visible: false }]);
  });

  it("下拉里子目录出小标题、其书签跟着它（顺序沿用导出时的）", async () => {
    seedBookmarks();
    const w = mountPanel();
    await flushPromises();

    await w.find(".bp-bm-folder").trigger("click");
    await flushPromises();

    expect(w.findAll(".bp-fmenu__item").map((n) => n.text())).toEqual(["A 站", "Z 站"]);
    expect(w.findAll(".bp-fmenu__group").map((n) => n.text())).toEqual(["漳蒲"]);
  });

  it("点下拉里的书签：先撤菜单（让位解除）再导航过去", async () => {
    seedBookmarks();
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-folder").trigger("click");
    await flushPromises();
    await w.findAll(".bp-fmenu__item")[0].trigger("click");
    await flushPromises();

    expect(w.findComponent(BookmarkFolderMenu).exists()).toBe(false);
    expect(lastArgsOf("browser_navigate")).toEqual([{ id: VIEW_ID, url: "https://a.com/" }]);
    expect(lastArgsOf("browser_set_visible")).toEqual([{ id: VIEW_ID, visible: true }]);
  });

  it("弹菜单不改地址栏（菜单里点的那条才改）", async () => {
    seedBookmarks();
    const w = mountPanel();
    await openView(w);
    const before = (w.find(".bp-address").element as HTMLInputElement).value;

    await w.find(".bp-bm-folder").trigger("click");
    await flushPromises();

    expect((w.find(".bp-address").element as HTMLInputElement).value).toBe(before);
  });
});
