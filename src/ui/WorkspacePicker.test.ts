// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// mock 边界指 @aide/sdk/api（共享 SDK 门面）——组件经 useWorkspaces 单例 →
// src/api.ts 壳 re-export 到同一实例，mock 包模块即覆盖整条链的 api 调用。
const listWorkspaces = vi.fn();
vi.mock("@aide/sdk/api", () => ({
  api: { listWorkspaces: (...args: unknown[]) => listWorkspaces(...args) },
}));

import WorkspacePicker from "./WorkspacePicker.vue";
import { useWorkspaces } from "../composables/useWorkspaces";

type Ws = { key: string; name: string; missing?: boolean };

const WS_A = { key: "a", name: "C:/repos/alpha", missing: false };
const WS_B = { key: "b", name: "C:/repos/beta", missing: false };
const WS_GONE = { key: "g", name: "C:/repos/gone", missing: true };

function mountPicker(path = "") {
  return mount(WorkspacePicker, {
    props: { path },
    global: { directives: { tooltip: {} }, stubs: { teleport: true } },
    attachTo: document.body,
  });
}

/** 挂起中的拉取放行阀：mock 返回未决 Promise，测试显式 release 数据。
 *  「加载中…」断言因此确定（拉取挂起中必现），不再赌微任务竞速。
 *  `!`（定值断言）理由：beforeEach 的 mockImplementation 每次被调用时同步
 *  赋值，而它只在组件触发拉取后才执行——`!` 让「开合不再触发拉取」的回归
 *  显式 TypeError 而非静默通过。 */
let release!: (ws: Ws[]) => void;

/** 点开下拉：断言加载态出现 → 放行数据 → 返回列表行文本数组。 */
async function openAndLoad(wrapper: ReturnType<typeof mountPicker>, data: Ws[] = [WS_A, WS_B, WS_GONE]) {
  await wrapper.get(".wp-trigger").trigger("click");
  expect(wrapper.text()).toContain("加载中…");
  release(data);
  await flushPromises();
  return wrapper.findAll(".wp-option").map((o) => o.text());
}

beforeEach(() => {
  listWorkspaces.mockReset();
  listWorkspaces.mockImplementation(
    () => new Promise<Ws[]>((r) => { release = r; }),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WorkspacePicker 触发按钮", () => {
  it("path 有值显示 basename，无值显示「未选择工作区」", () => {
    const w = mountPicker("C:/repos/alpha");
    expect(w.get(".wp-trigger").text()).toBe("alpha");

    const w2 = mountPicker("");
    expect(w2.get(".wp-trigger").text()).toBe("未选择工作区");
  });

  it("点开惰性加载列表（loading 态→选项渲染），再点关闭；关闭态不调 api", async () => {
    const w = mountPicker("C:/repos/alpha");
    expect(listWorkspaces).not.toHaveBeenCalled();

    const labels = await openAndLoad(w);
    // active 项行尾带 ✓ 勾选符
    expect(labels).toEqual(["alpha✓", "beta", "gone"]);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    await w.get(".wp-trigger").trigger("click");
    expect(w.find(".wp-dropdown").exists()).toBe(false);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("api 拉取失败 → 空列表兜底（catch 收窄），显示「无其它工作区」", async () => {
    listWorkspaces.mockRejectedValueOnce(new Error("boom"));
    const w = mountPicker("C:/repos/alpha");
    await w.get(".wp-trigger").trigger("click");
    await flushPromises();
    expect(w.find(".wp-dropdown").text()).toContain("无其它工作区");
    expect(w.findAll(".wp-option")).toHaveLength(0);
  });

  it("拉取经 useWorkspaces 单例：展开后共享列表被填充（收口契约，防回退直调）", async () => {
    // 自包含化（判别力与执行顺序解耦）：先借一次失败拉取清空共享单例、断言
    // 起点为空，再经 openAndLoad 放行——若组件回退直调（不写单例），残留的
    // 前序数据会让本测试在全绿下静默失效；起点置空后该回归必然暴露。
    listWorkspaces.mockRejectedValueOnce(new Error("清场"));
    const w = mountPicker("C:/repos/alpha");
    await w.get(".wp-trigger").trigger("click");
    await flushPromises();

    const { workspaces } = useWorkspaces();
    expect(workspaces.value).toEqual([]);

    await w.get(".wp-trigger").trigger("click"); // 关闭，重开走 openAndLoad
    await openAndLoad(w);
    expect(workspaces.value.map((x) => x.key)).toEqual(["a", "b", "g"]);
  });
});

describe("WorkspacePicker 选项与守卫", () => {
  it("当前 path 命中项带 ✓（active）；missing 项禁用", async () => {
    const w = mountPicker("C:/repos/alpha");
    await openAndLoad(w);

    const options = w.findAll(".wp-option");
    expect(options[0].classes()).toContain("active");
    expect(options[0].text()).toContain("✓");
    expect(options[1].classes()).not.toContain("active");
    expect(options[2].attributes("disabled")).toBeDefined();
  });

  it("点选项 emit select 且关闭；missing 项不 emit（pick 内守卫 + disabled 双防线）", async () => {
    const w = mountPicker("C:/repos/alpha");
    await openAndLoad(w);

    await w.findAll(".wp-option")[1].trigger("click");
    expect(w.emitted("select")?.[0]?.[0]).toEqual(WS_B);
    expect(w.find(".wp-dropdown").exists()).toBe(false);

    await openAndLoad(w);
    const options = w.findAll(".wp-option");
    // ① 用户真实点击路径：disabled 按钮 trigger 不派发（VTU 跳过）→ 不 emit，
    //    下拉保持开（无状态变化）
    await options[2].trigger("click");
    expect(w.emitted("select")).toHaveLength(1);
    expect(w.find(".wp-dropdown").exists()).toBe(true);

    // ② pick 守卫分支直测：移除 disabled 绕过 DOM 层，点击直达 pick 的
    //    if (ws.missing) return——仍不 emit，且下拉随 pick 关闭
    // cast 理由：jsdom 返回泛型 Element，需 button API 移除 disabled
    (options[2].element as HTMLButtonElement).removeAttribute("disabled");
    await options[2].trigger("click");
    expect(w.find(".wp-dropdown").exists()).toBe(false);
    expect(w.emitted("select")).toHaveLength(1);
  });
});

describe("WorkspacePicker 关闭路径", () => {
  it("Esc 开着时关闭并 preventDefault；关着时不消费", async () => {
    const w = mountPicker("C:/repos/alpha");
    await openAndLoad(w);

    // cancelable: true——jsdom 事件默认不可取消，preventDefault 不生效
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(esc);
    await flushPromises();
    expect(w.find(".wp-dropdown").exists()).toBe(false);
    expect(esc.defaultPrevented).toBe(true);

    const esc2 = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(esc2);
    expect(esc2.defaultPrevented).toBe(false);
  });

  it("点击根外关闭；点击下拉本体（根内）不关", async () => {
    const w = mountPicker("C:/repos/alpha");
    await openAndLoad(w);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(w.find(".wp-dropdown").exists()).toBe(false);

    await openAndLoad(w);
    w.get(".wp-dropdown").element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(w.find(".wp-dropdown").exists()).toBe(true);
  });

  it("卸载后 click/keydown（document）与 resize（window）监听清理（F2）", async () => {
    const removeDocSpy = vi.spyOn(document, "removeEventListener");
    const removeWinSpy = vi.spyOn(window, "removeEventListener");
    const w = mountPicker("C:/repos/alpha");
    await openAndLoad(w); // 开 → 挂 keydown（document）+ resize（window）
    w.unmount();

    expect(removeDocSpy.mock.calls.map((c) => c[0])).toContain("click");
    expect(removeDocSpy.mock.calls.map((c) => c[0])).toContain("keydown");
    expect(removeWinSpy.mock.calls.map((c) => c[0])).toContain("resize");
    removeDocSpy.mockRestore();
    removeWinSpy.mockRestore();
  });
});

describe("WorkspacePicker #trigger slot 接管（FileTree 形态）", () => {
  it("slot 按钮驱动开合，slot props.open 供 chevron 旋转；默认触发按钮不渲染", async () => {
    const w = mount(WorkspacePicker, {
      props: { path: "C:/repos/alpha" },
      global: { directives: { tooltip: {} }, stubs: { teleport: true } },
      slots: {
        trigger: `<template #trigger="{ open, toggle }">
          <button class="ft-trigger" @click.stop="toggle"><i :class="{ open }" data-test="chev"/></button>
        </template>`,
      },
      attachTo: document.body,
    });

    expect(w.find(".wp-trigger").exists()).toBe(false);
    expect(w.get('[data-test="chev"]').classes()).not.toContain("open");

    await w.get(".ft-trigger").trigger("click");
    await flushPromises();
    expect(w.find(".wp-dropdown").exists()).toBe(true);
    expect(w.get('[data-test="chev"]').classes()).toContain("open");
  });

  it("slot 形态下选项点击仍走同一套守卫与 emit", async () => {
    const w = mount(WorkspacePicker, {
      props: { path: "C:/repos/alpha" },
      global: { directives: { tooltip: {} }, stubs: { teleport: true } },
      slots: {
        trigger: `<template #trigger="{ toggle }">
          <button class="ft-trigger" @click.stop="toggle"/>
        </template>`,
      },
      attachTo: document.body,
    });

    await w.get(".ft-trigger").trigger("click");
    expect(w.find(".wp-dropdown").text()).toContain("加载中…");
    release([WS_A, WS_B, WS_GONE]);
    await flushPromises();
    await w.findAll(".wp-option")[1].trigger("click");
    expect(w.emitted("select")?.[0]?.[0]).toEqual(WS_B);
  });
});

describe("WorkspacePicker 定位（positionMenu）", () => {
  /** jsdom getBoundingClientRect 恒 0，锚点矩形须 mock；其余字段不参与定位 */
  // cast 理由：jsdom 无真实布局，用平面对象补齐 DOMRect 形状
  function mockAnchorRect(w: ReturnType<typeof mountPicker>, top: number, bottom: number, left: number, width: number) {
    vi.spyOn(w.get(".workspace-picker").element, "getBoundingClientRect").mockReturnValue({
      top, bottom, left, width, height: bottom - top,
      right: left + width, x: left, y: top, toJSON: () => ({}),
    } as DOMRect);
  }

  it("下方空间不足（按 max-height 260 假定）且上方更宽裕 → 上翻 bottom 锚定", async () => {
    // jsdom innerHeight=768：锚点贴底（spaceBelow=38 < 268）→ 上翻
    const w = mountPicker("C:/repos/alpha");
    mockAnchorRect(w, 700, 730, 0, 200);
    await w.get(".wp-trigger").trigger("click");
    await flushPromises();

    const style = w.get(".wp-dropdown").attributes("style");
    expect(style).toContain(`bottom: ${768 - 700 + 4}px`);
    expect(style).toContain("top: auto");
    expect(style).toContain("visibility: visible"); // positioned 完成后可见
  });

  it("下方空间充足 → 下翻 top 锚定；横向越界钳制到视口右缘内", async () => {
    // jsdom innerWidth=1024：锚点 left=800 width=300 → 1100 越过 1016 → 钳到 716
    const w = mountPicker("C:/repos/alpha");
    mockAnchorRect(w, 0, 30, 800, 300);
    await w.get(".wp-trigger").trigger("click");
    await flushPromises();

    const style = w.get(".wp-dropdown").attributes("style");
    expect(style).toContain("top: 34px");
    expect(style).toContain("left: 716px");
    expect(style).not.toContain("bottom");
  });

  it("Teleport 真身（不 stub）：点菜单本体不关（insideMenu 域），点根外关", async () => {
    const w = mount(WorkspacePicker, {
      props: { path: "C:/repos/alpha" },
      global: { directives: { tooltip: {} } }, // 真 Teleport 到 body
      attachTo: document.body,
    });
    await w.get(".wp-trigger").trigger("click");
    await flushPromises();

    const menu = document.querySelector(".wp-dropdown");
    expect(menu).not.toBeNull();
    menu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".wp-dropdown")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(document.querySelector(".wp-dropdown")).toBeNull();
    w.unmount();
  });
});