// @vitest-environment jsdom
// 组件挂载需要 document，jsdom 环境。
import { describe, it, expect, vi } from "vitest";

// 组件树 import 链拉到 useFileViewer/useSettings 等（jsdom 下 document 可用），
// api 边界一律 mock 到 @aide/sdk/api（不是壳 @/api——壳与包内模块实例不同），
// 与 useFileViewer.test.ts 同口径。
vi.mock("@aide/sdk/api", () => ({
  api: new Proxy({}, { get: () => vi.fn(async () => undefined) }),
}));

import { mount } from "@vue/test-utils";
import TreeNodeItem from "./TreeNodeItem.vue";

const ROOT = "C:\\proj";

function mountTree() {
  return mount(TreeNodeItem, {
    props: {
      node: {
        name: "src",
        path: `${ROOT}\\src`,
        is_dir: true,
        children: [
          {
            name: "sub",
            path: `${ROOT}\\src\\sub`,
            is_dir: true,
            children: null,
          },
        ],
      },
      depth: 0,
      expandedDirs: new Set([`${ROOT}\\src`]),
      selectedPath: "",
      projectRoot: ROOT,
      onRefreshDir: () => {},
    },
  });
}

describe("TreeNodeItem 选中事件传导", () => {
  it("单击顶层行 → 组件 emit select（嵌套行同理）", async () => {
    const wrapper = mountTree();
    await wrapper.find(".tree-node").trigger("click");
    expect(wrapper.emitted("select")).toContainEqual([`${ROOT}\\src`]);
  });

  it("嵌套子行单击的 select 必须向上传导到顶层组件——回归：漏递归转发时选中高亮停在上一级", async () => {
    const wrapper = mountTree();
    const nested = wrapper.findAllComponents({ name: "TreeNodeItem" })[0];
    await nested.find(".tree-node").trigger("click");
    // 断言的是顶层组件的 emitted——嵌套行自己 emit 了不算，必须冒上来
    expect(wrapper.emitted("select")).toContainEqual([`${ROOT}\\src\\sub`]);
  });

  it("嵌套子行双击目录 → toggle 向上传导（既有行为保持）", async () => {
    const wrapper = mountTree();
    const nested = wrapper.findAllComponents({ name: "TreeNodeItem" })[0];
    await nested.find(".tree-node").trigger("dblclick");
    expect(wrapper.emitted("toggle")).toContainEqual([`${ROOT}\\src\\sub`]);
  });

  it("双击文件行 → open 向上传导（既有行为保持）", async () => {
    const wrapper = mount(TreeNodeItem, {
      props: {
        node: { name: "a.ts", path: `${ROOT}\\a.ts`, is_dir: false, children: null },
        depth: 0,
        expandedDirs: new Set<string>(),
        selectedPath: "",
        projectRoot: ROOT,
        onRefreshDir: () => {},
      },
    });
    await wrapper.find(".tree-node").trigger("dblclick");
    expect(wrapper.emitted("open")).toContainEqual([`${ROOT}\\a.ts`]);
    await wrapper.find(".tree-node").trigger("click");
    expect(wrapper.emitted("select")).toContainEqual([`${ROOT}\\a.ts`]);
  });
});

describe("TreeNodeItem 悬停截断名按需左移", () => {
  it("悬停只左移实际缺口（缺口 20px 移 20px），离开复原——回归：旧实现不论缺口固定跳满 depth×12 压过参考线", async () => {
    // jsdom 无布局：stub HTMLElement 宽度 getter，模拟名字截断 20px
    const origSW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const origCW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 180 });
    try {
      const wrapper = mount(TreeNodeItem, {
        props: {
          node: {
            name: "GrowthProcessRecordController.ts",
            path: `${ROOT}\\deep\\GrowthProcessRecordController.ts`,
            is_dir: false,
            children: null,
          },
          depth: 5,
          expandedDirs: new Set<string>(),
          selectedPath: "",
          projectRoot: ROOT,
          onRefreshDir: () => {},
        },
      });
      const row = wrapper.find(".tree-node");
      expect(row.attributes("style")).toContain("padding-left: 98px"); // 5*18+8 未悬停
      await row.trigger("mouseenter");
      expect(row.attributes("style")).toContain("padding-left: 76px"); // 98−(20+2) 按需+余量
      await row.trigger("mouseleave");
      expect(row.attributes("style")).toContain("padding-left: 98px");
    } finally {
      if (origSW) Object.defineProperty(HTMLElement.prototype, "scrollWidth", origSW);
      if (origCW) Object.defineProperty(HTMLElement.prototype, "clientWidth", origCW);
    }
  });

  it("悬停瞬间重新测量：挂载后文字被选中加粗撑宽（盒子不变、ResizeObserver 不触发），左移按最新缺口——回归：旧实现靠 RO 维持测量，吃旧值差 1~2 字符", async () => {
    const origSW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const origCW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    // 挂载时缺口 20px
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 180 });
    try {
      const wrapper = mount(TreeNodeItem, {
        props: {
          node: {
            name: "PlanController.java",
            path: `${ROOT}\\deep\\PlanController.java`,
            is_dir: false,
            children: null,
          },
          depth: 5,
          expandedDirs: new Set<string>(),
          selectedPath: "",
          projectRoot: ROOT,
          onRefreshDir: () => {},
        },
      });
      const row = wrapper.find(".tree-node");
      // 模拟选中加粗：内容撑宽到缺口 30px，span 盒子宽度不变（flex 定宽）→ RO 不回调
      Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 210 });
      await row.trigger("mouseenter");
      expect(row.attributes("style")).toContain("padding-left: 66px"); // 98−(30+2) 按最新缺口+余量
    } finally {
      if (origSW) Object.defineProperty(HTMLElement.prototype, "scrollWidth", origSW);
      if (origCW) Object.defineProperty(HTMLElement.prototype, "clientWidth", origCW);
    }
  });
});