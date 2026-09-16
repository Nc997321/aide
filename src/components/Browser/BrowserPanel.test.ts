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
import { useBrowserPanel } from "../../composables/useBrowserPanel";

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
      stubs: { FilePickerDialog: FilePickerStub },
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
    return undefined;
  });
  useBrowserPanel().openPanel();
});

afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useBrowserPanel().closePanel();
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
    useBrowserPanel().closePanel(); // 浮层还开着
    await flushPromises();
    useBrowserPanel().openPanel();
    await flushPromises();

    expect(lastArgsOf("browser_set_visible")).toEqual([{ id: VIEW_ID, visible: false }]);
  });
});
