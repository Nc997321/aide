// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import CodegraphPanel from "./CodegraphPanel.vue";

const { setRootEnabledMock, refreshEnabledForMock, rescanMock, rebuildMock } = vi.hoisted(() => ({
  setRootEnabledMock: vi.fn(async () => undefined),
  refreshEnabledForMock: vi.fn(async () => true),
  rescanMock: vi.fn(async () => undefined),
  rebuildMock: vi.fn(() => {}),
}));

// 门面是模块级单例：测试里用可写的 enabledForRoot 模拟「某工作区开关状态」。
// mock 边界指 src/composables 壳（与组件同解析路径），不指 @aide/sdk 包内模块。
const enabledForRoot = ref<Record<string, boolean>>({});
vi.mock("../../composables/useCodeGraphProgress", () => ({
  useCodeGraphProgress: () => ({
    enabledForRoot,
    lastBuild: ref(null),
    lastBuildRoot: ref(""),
    building: ref(false),
    setRootEnabled: setRootEnabledMock,
    refreshEnabledFor: refreshEnabledForMock,
    rescan: rescanMock,
    rebuild: rebuildMock,
  }),
}));

function mountPanel(root = "C:/proj") {
  return mount(CodegraphPanel, { props: { workspaceRoot: root } });
}

beforeEach(() => {
  enabledForRoot.value = {};
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CodegraphPanel", () => {
  it("未选工作区：显示提示、不渲染开关", () => {
    const w = mountPanel("");
    expect(w.text()).toContain("未选择工作区");
    expect(w.find(".toggle input").exists()).toBe(false);
    expect(refreshEnabledForMock).not.toHaveBeenCalled();
  });

  it("挂载/切工作区时权威拉取该工作区开关", async () => {
    mountPanel("C:/proj");
    await flushPromises();
    expect(refreshEnabledForMock).toHaveBeenCalledWith("C:/proj");
  });

  it("开关开：toggle checked、维护按钮可用", async () => {
    enabledForRoot.value = { "C:/proj": true };
    const w = mountPanel();
    await flushPromises();
    expect(w.find<HTMLInputElement>(".toggle input").element.checked).toBe(true);
    const buttons = w.findAll<HTMLButtonElement>(".cg-action-btn");
    for (const b of buttons) expect(b.element.disabled).toBe(false);
  });

  it("开关关（默认）：按钮禁用 + 显示关闭态说明", () => {
    const w = mountPanel();
    expect(w.find<HTMLInputElement>(".toggle input").element.checked).toBe(false);
    for (const b of w.findAll<HTMLButtonElement>(".cg-action-btn")) {
      expect(b.element.disabled).toBe(true);
    }
    expect(w.text()).toContain("代码索引已关闭");
  });

  it("toggle 切换调门面 setRootEnabled（开）", async () => {
    enabledForRoot.value = { "C:/proj": false };
    const w = mountPanel();
    await flushPromises();
    const input = w.find<HTMLInputElement>(".toggle input");
    input.setValue(true);
    await flushPromises();
    expect(setRootEnabledMock).toHaveBeenCalledWith("C:/proj", true);
  });

  it("开关关：更新/全量重建按钮不再触发门面操作（禁用兜底）", async () => {
    const w = mountPanel();
    await w.findAll<HTMLButtonElement>(".cg-action-btn")[1].trigger("click");
    expect(rescanMock).not.toHaveBeenCalled();
    expect(rebuildMock).not.toHaveBeenCalled();
  });

  it("维护按钮开态触发 rescan / rebuild", async () => {
    enabledForRoot.value = { "C:/proj": true };
    const w = mountPanel();
    await flushPromises();
    const buttons = w.findAll<HTMLButtonElement>(".cg-action-btn");
    await buttons[0].trigger("click");
    expect(rescanMock).toHaveBeenCalledWith("C:/proj");
    await buttons[1].trigger("click");
    expect(rebuildMock).toHaveBeenCalledWith("C:/proj");
  });
});