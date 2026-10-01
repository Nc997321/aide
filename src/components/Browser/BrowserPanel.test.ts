// @vitest-environment jsdom
//
// 回归：原生 WebView2 子视图浮在所有 HTML 之上（**不受 z-index 约束**，见 BrowserPanel.vue 顶部
// 「物理约束」），所以面板内的 HTML 浮层一开，原生视图必须让位——否则浮层只有「洞」以上那一条
// 可见，其余被网页整个吃掉（导入书签的文件选择器只剩标题 + 地址行，取消/确认按钮全不见）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick, withDirectives } from "vue";

import { vOverlayLayer } from "../../directives/overlayLayer";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

/** 事件通道的订阅者（按事件名）。收起 `listen` 的回调，测试才能自己投递**导航事件**
 *  ——它和视图生命周期事件是两条独立的真相通道，驱逐重复标签的路径也因此有两条。 */
const listeners = new Map<string, (ev: { payload: unknown }) => void>();

import BrowserPanel from "./BrowserPanel.vue";
import BookmarkFolderMenu from "./BookmarkFolderMenu.vue";
import { useRightPanel, __resetRightPanelForTest } from "../../composables/useRightPanel";
import {
  __resetBrowserViewsForTest,
  useBrowserViews,
} from "../../composables/browser/useBrowserViews";

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
  listenMock.mockReset();
  listeners.clear();
  listenMock.mockImplementation(async (name: string, cb: (ev: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => {};
  });
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
        displayed: true,
      };
    }
    // 挂载对账：默认库里没有别处建出来的视图（要测对账的用例自己覆盖这条）。
    if (cmd === "browser_views_list") return [];
    if (cmd === "browser_bookmarks_list") return [];
    // 图标回**空表**（不是 undefined/空数组）：回错类型会静默变成"所有图标都没有"。
    if (cmd === "browser_favicons") return {};
    return undefined;
  });
  // 面板开合现在归 useRightPanel：select('browser') = 展开右栏并激活浏览器 tab。
  __resetRightPanelForTest();
  __resetBrowserViewsForTest();
  useRightPanel().select("browser");
});

afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetRightPanelForTest();
  __resetBrowserViewsForTest();
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

    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: false }]);
  });

  it("关掉文件选择器 → 原生视图回来（并重新贴合占位洞坐标）", async () => {
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();
    w.findComponent(FilePickerStub).vm.$emit("update:visible", false);
    await flushPromises();

    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: true }]);
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

    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: false }]);
  });
});

describe("浮层盖上来时的定格画面（让位后洞里不能是灰的）", () => {
  const SHOT = "data:image/jpeg;base64,/9j/AAA";

  /** 在默认 invoke 实现上叠加 `browser_snapshot` 的行为。 */
  function withSnapshot(impl: () => Promise<unknown>) {
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) =>
      cmd === "browser_snapshot" ? impl() : base(cmd, args),
    );
  }

  /** 调用顺序：snapshot 必须排在 set_displayed(false) 之前（隐藏的视图拍不出画面）。 */
  function order(): string[] {
    return invokeMock.mock.calls
      .map((c) => (c[0] === "browser_set_displayed" ? `displayed:${(c[1] as { displayed: boolean }).displayed}` : c[0] as string))
      .filter((c) => c === "browser_snapshot" || c.startsWith("displayed:"));
  }

  it("浮层打开：先拍快照、画面铺进洞里、再让位；浮层关掉：视图回来后才撤画面", async () => {
    withSnapshot(async () => SHOT);
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();

    expect(lastArgsOf("browser_snapshot")).toEqual([{ id: VIEW_ID }]);
    expect(w.find(".bp-snapshot").attributes("src")).toBe(SHOT);
    expect(order().slice(-2)).toEqual(["browser_snapshot", "displayed:false"]);

    w.findComponent(FilePickerStub).vm.$emit("update:visible", false);
    await flushPromises();

    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: true }]);
    expect(w.find(".bp-snapshot").exists()).toBe(false);
  });

  it("快照拍失败：不挡让位，洞里没有画面（退回灰洞），失败留痕", async () => {
    withSnapshot(async () => {
      throw "cdp unavailable";
    });
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();

    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: false }]);
    expect(w.find(".bp-snapshot").exists()).toBe(false);
    expect(lastArgsOf("log_frontend_error")?.[0]).toEqual({
      message: expect.stringContaining("snapshot view-1 failed: cdp unavailable"),
    });
  });

  it("后端回的不是 data:image 就不进 <img>（不放行其他形态）", async () => {
    withSnapshot(async () => "https://evil.example/x.png");
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();

    expect(w.find(".bp-snapshot").exists()).toBe(false);
    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: false }]);
  });

  it("快照还在路上浮层就关了：过期结果不落地，也不再让位", async () => {
    let finish!: (v: string) => void;
    withSnapshot(() => new Promise((r) => (finish = r as (v: string) => void)));
    const w = mountPanel();
    await openView(w);

    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();
    w.findComponent(FilePickerStub).vm.$emit("update:visible", false); // 快照尚未回来
    await flushPromises();
    finish(SHOT);
    await flushPromises();

    expect(w.find(".bp-snapshot").exists()).toBe(false);
    // 从未让位（面板一直该显示着）：最后一次 displayed 调用只会是 true
    expect(order().filter((c) => c === "displayed:false")).toHaveLength(0);
  });

  it("面板自己合上（不是浮层）：不拍快照（洞本来就看不见）", async () => {
    withSnapshot(async () => SHOT);
    const w = mountPanel();
    await openView(w);

    useRightPanel().select("browser"); // 折叠
    await flushPromises();

    expect(lastArgsOf("browser_snapshot")).toBeNull();
    expect(w.find(".bp-snapshot").exists()).toBe(false);
    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: false }]);
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
    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: false }]);
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
    expect(lastArgsOf("browser_set_displayed")).toEqual([{ id: VIEW_ID, displayed: true }]);
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

// ── agent 自建 tab：走视图生命周期事件长出来 ──
//
// 这是本批特性的正面回归：视图可以由**别的驱动者**创建（Rust 的 open op），面板只能靠
// `browser-view` 事件知道它存在——旧实现里"认不出的视图 id 一律忽略"，agent 的 tab 就永远
// 不会出现在标签条上。
describe("agent 的 tab", () => {
  it("收到 created 事件 → 标签条上长出一个带归属标记的标签", async () => {
    const w = mountPanel();
    await flushPromises();

    const v = useBrowserViews();
    v.__handleViewForTest({
      id: "browser-9",
      kind: "created",
      label: "vue-admin dev",
      origin: "agent",
      displayed: false,
    });
    await nextTick();

    expect(w.findAll(".bp-tab-label").map((n) => n.text())).toContain("vue-admin dev");
    expect(w.findAll(".bp-tab-agent")).toHaveLength(1);
  });

  it("挂载时对账：事件早于面板的视图也要补出标签", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "browser_views_list") {
        return [
          {
            id: "browser-9",
            nav: { state: "ready", url: "http://localhost:5173/", title: "Vite App" },
            can_go_back: false,
            can_go_forward: false,
            bounds: { x: 0, y: 0, w: 0, h: 0 },
            displayed: false,
            label: "vue-admin dev",
            origin: "agent",
          },
        ];
      }
      if (cmd === "browser_bookmarks_list") return [];
      if (cmd === "browser_favicons") return {};
      return undefined;
    });

    const w = mountPanel();
    await flushPromises();

    expect(w.findAll(".bp-tab-label").map((n) => n.text())).toContain("vue-admin dev");
  });

  it("focus 请求 → 切到那个标签；视图被关掉 → 标签跟着消失", async () => {
    const w = mountPanel();
    await flushPromises();
    const v = useBrowserViews();

    v.__handleViewForTest({
      id: "browser-9",
      kind: "created",
      label: "dev",
      origin: "agent",
      displayed: false,
    });
    await nextTick();

    v.__handleFocusForTest({ id: "browser-9" });
    await nextTick();
    expect(w.find(".bp-tab.on .bp-tab-label").text()).toBe("dev");

    v.__handleViewForTest({
      id: "browser-9",
      kind: "closed",
      label: "dev",
      origin: "agent",
      displayed: false,
    });
    await nextTick();
    expect(w.findAll(".bp-tab-label").map((n) => n.text())).not.toContain("dev");
    // 视图已经是别人关的：面板**不许**再发一次 close
    expect(lastArgsOf("browser_close")).toBeNull();
  });
});

// ── 自己 create 的回声：先行到达，不许长出第二个标签 ──
//
// 面板自己开的网页也走"认不出的视图 id"这条路。`browser_create` 是 async 命令：Rust 在
// **create 内部**就广播了 `browser-view created`（facade.rs 里 `broadcast_view` 在回快照之前），
// 而应答要绕 tokio worker 回来——**回声恒先于应答**，所以真机上每次都犯，不是偶发竞态。
// 那一刻新标签还没有 viewId（id 在应答里），两条采纳路径（created 事件、nav 事件）都会把它当成
// "别人开的 tab"再长一个：同一个视图两个标签，后长的那个再也收不到后续事件（`find` 只认第一个），
// 永远空白——真机上就是"访问一个新网页就多一个空标签页"。
describe("自己 create 的回声", () => {
  /** 扣住 `browser_create` 的应答，让"回声先到"这个真实时序在测试里确定发生。 */
  function stallCreate() {
    let release!: (v: unknown) => void;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "browser_create") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      if (cmd === "browser_views_list") return [];
      if (cmd === "browser_bookmarks_list") return [];
      if (cmd === "browser_favicons") return {};
      return undefined;
    });
    return () =>
      release({
        id: VIEW_ID,
        nav: { state: "ready", url: "https://example.com/", title: "example" },
        can_go_back: false,
        can_go_forward: false,
        bounds: { x: 0, y: 0, w: 0, h: 0 },
        displayed: true,
        label: null,
        origin: "user",
      });
  }

  /** 地址栏回车 → 面板开始建视图（应答被扣住，还在飞）。 */
  async function startOpen(w: VueWrapper) {
    const addr = w.find(".bp-address");
    await addr.setValue("https://example.com");
    await addr.trigger("keydown.enter");
    await flushPromises();
    expect(lastArgsOf("browser_create")).not.toBeNull(); // 确实在飞，别让用例空跑
  }

  function createdEcho(id: string, label: string | null, origin: "user" | "agent") {
    useBrowserViews().__handleViewForTest({ id, kind: "created", label, origin, displayed: true });
  }

  it("created 回声先到 → 只有一个标签（不是同一个页面两个标签）", async () => {
    const w = mountPanel();
    await flushPromises();
    const release = stallCreate();
    await startOpen(w);

    createdEcho(VIEW_ID, null, "user");
    await flushPromises();

    release();
    await flushPromises();

    expect(w.findAll(".bp-tab")).toHaveLength(1);
    expect(w.findAll(".bp-tab-label").map((n) => n.text())).not.toContain("新标签页");
  });

  it("导航回声先到（加载信号抢在 created 前面）→ 同样只有一个标签", async () => {
    const w = mountPanel();
    await flushPromises();
    const release = stallCreate();
    await startOpen(w);

    // 页面加载信号可能在 create 期间就发出来（facade 注释明说）——那时 created 还没广播，
    // 标签条上认不出这个 id。
    listeners.get("browser-nav")?.({
      payload: {
        id: VIEW_ID,
        can_go_back: false,
        can_go_forward: false,
        state: "loading",
        url: "https://example.com/",
      },
    });
    await flushPromises();

    release();
    await flushPromises();

    expect(w.findAll(".bp-tab")).toHaveLength(1);
  });

  it("自己 create 期间到达的 agent 视图：押后回放，最后照旧长出来", async () => {
    const w = mountPanel();
    await flushPromises();
    const release = stallCreate();
    await startOpen(w);

    createdEcho(VIEW_ID, null, "user");
    createdEcho("browser-9", "vue-admin dev", "agent");
    await flushPromises();

    release();
    await flushPromises();

    expect(w.findAll(".bp-tab-label").map((n) => n.text())).toContain("vue-admin dev");
    expect(w.findAll(".bp-tab")).toHaveLength(2);
  });

  it("押后期间视图被关掉 → 回放不该补出一个幽灵标签", async () => {
    const w = mountPanel();
    await flushPromises();
    const release = stallCreate();
    await startOpen(w);

    createdEcho("browser-9", "dev", "agent");
    await flushPromises();
    useBrowserViews().__handleViewForTest({
      id: "browser-9",
      kind: "closed",
      label: "dev",
      origin: "agent",
      displayed: false,
    });
    await flushPromises();

    release();
    await flushPromises();

    expect(w.findAll(".bp-tab-label").map((n) => n.text())).not.toContain("dev");
  });
});

describe("别的模块请求打开一个地址（资料库的网页产物预览）", () => {
  it("openInBrowser 的待办被面板消费，地址真的交给 browser_create", async () => {
    const w = mountPanel();
    await flushPromises();

    useRightPanel().openInBrowser("http://127.0.0.1:18788/p/abc123");
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith(
      "browser_create",
      expect.objectContaining({
        dto: expect.objectContaining({ url: "http://127.0.0.1:18788/p/abc123" }),
      }),
    );
    // 消费掉：不会被第二个面板实例重复打开
    expect(useRightPanel().pendingBrowserUrl.value).toBeNull();
    expect(w.findAll(".bp-tab")).toHaveLength(2); // 新开一页，不动原来那页
  });

  it("有浮层盖着时先不消费——等浮层关掉再打开（那时占位洞才量得到尺寸）", async () => {
    const w = mountPanel();
    await flushPromises();
    // 面板内的浮层（导入书签的文件选择器）：原生视图此时必须让位，占位洞不可量
    await w.find(".bp-bm-import").trigger("click");
    await flushPromises();

    useRightPanel().openInBrowser("http://127.0.0.1:18788/p/later");
    await flushPromises();

    expect(useRightPanel().pendingBrowserUrl.value).toBe("http://127.0.0.1:18788/p/later");
    expect(lastArgsOf("browser_create")).toBeNull();

    w.findComponent(FilePickerStub).vm.$emit("update:visible", false);
    await flushPromises();

    expect(lastArgsOf("browser_create")).toEqual([
      { dto: expect.objectContaining({ url: "http://127.0.0.1:18788/p/later" }) },
    ]);
    expect(useRightPanel().pendingBrowserUrl.value).toBeNull();
  });
});
