// @vitest-environment jsdom
// 组件挂载需要 document（ResizeObserver/onMounted 读元素），jsdom + stub。
import { describe, it, expect, vi } from "vitest";

// 组件树 import 链拉到 useFileViewer/useSettings 等（jsdom 下 document 可用），
// api 边界一律 mock 到 @aide/sdk/api（不是壳 @/api——壳与包内模块实例不同），
// 与 useFileViewer.test.ts 同口径。
vi.mock("@aide/sdk/api", () => ({
  api: new Proxy({}, { get: () => vi.fn(async () => undefined) }),
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

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