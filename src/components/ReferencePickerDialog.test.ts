// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import ReferencePickerDialog from "./ReferencePickerDialog.vue";
const mocks = vi.hoisted(() => ({
  current: vi.fn(async () => ({ key: "ssh:build", home: "/home/user", label: "build" })),
  pathTypes: vi.fn(async () => ["dir"]),
}));
vi.mock("@aide/sdk", () => ({ hostApi: { current: mocks.current } }));
vi.mock("@aide/sdk/api", () => ({ api: { pathTypes: mocks.pathTypes } }));
enableAutoUnmount(afterEach);
function create() {
  return mount(ReferencePickerDialog, { props: { visible: true, initialPath: "/work" },
    global: { stubs: { Teleport: true, DirTreePicker: { name: "DirTreePicker", template: '<div class="tree" />', props: ["roots", "mode", "selectDirectories"] } } },
  });
}
describe("ReferencePickerDialog", () => {
  it("使用当前 Host 的根，选择目录明确说明用途，确认不登记或信任项目", async () => {
    mocks.pathTypes.mockResolvedValue(["dir"]);
    const w = create();
    await flushPromises();
    const tree = w.findComponent({ name: "DirTreePicker" });
    expect(tree.props("roots").map((r: any) => r.path)).toEqual(["/home/user", "/"]);
    expect(w.text()).toContain("不自动加载工程规则与记忆");
    await w.get(".confirm").trigger("click");
    await flushPromises();
    expect(w.emitted("confirm")).toEqual([["/work", true]]);
  });
  it("不存在的路径不关闭弹窗，不产生引用", async () => {
    mocks.pathTypes.mockResolvedValue(["none"]);
    const w = create();
    await flushPromises();
    await w.get(".confirm").trigger("click");
    await flushPromises();
    expect(w.emitted("confirm")).toBeUndefined();
    expect(w.get('[role="alert"]').text()).toContain("存在的文件或文件夹");
  });
});
