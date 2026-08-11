// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

const wsMock = vi.hoisted(() => ({
  activeKey: { value: null as string | null },
  openFolder: vi.fn(),
}));
const obMock = vi.hoisted(() => ({
  advance: vi.fn(),
  step: { value: "workspace" },
}));
const getProjectInfo = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("../../../composables/useWorkspaces", () => ({ useWorkspaces: () => wsMock }));
vi.mock("../../../composables/useOnboarding", () => ({ useOnboarding: () => obMock }));
vi.mock("../../../api", () => ({ api: { getProjectInfo: () => getProjectInfo.fn() } }));
// DirTreePicker 替换为可触发 update:modelValue 的桩，隔离真实树渲染 + api
vi.mock("../../DirTreePicker.vue", () => ({
  default: {
    name: "DirTreePicker",
    props: ["modelValue"],
    emits: ["update:modelValue"],
    template: `<button class="pick-stub" @click="$emit('update:modelValue', 'C:/dev/proj')">pick</button>`,
  },
}));

import WorkspaceStep from "./WorkspaceStep.vue";

const flush = () => new Promise((r) => setTimeout(r, 0));
function mountStep() {
  return mount(WorkspaceStep, { attachTo: document.body });
}

describe("WorkspaceStep", () => {
  beforeEach(() => {
    wsMock.activeKey.value = null;
    wsMock.openFolder.mockReset();
    wsMock.openFolder.mockResolvedValue({ key: "k", path: "C:/dev/proj", name: "proj" } as any);
    obMock.advance.mockReset();
    getProjectInfo.fn.mockReset();
    getProjectInfo.fn.mockResolvedValue({ root: null } as any); // 默认无工作区
  });

  it("无路径时确认按钮禁用", () => {
    const w = mountStep();
    expect(w.find(".confirm-btn").attributes("disabled")).toBeDefined();
  });

  it("选路径 + 确认 → openFolder(path) + emit selected + advance", async () => {
    const w = mountStep();
    await w.find(".pick-stub").trigger("click");   // 选定路径
    await w.find(".confirm-btn").trigger("click"); // 确认
    await flush();
    expect(wsMock.openFolder).toHaveBeenCalledWith("C:/dev/proj");
    expect(w.emitted("selected")).toBeTruthy();
    expect(w.emitted("selected")![0]).toEqual(["C:/dev/proj"]);
    expect(obMock.advance).toHaveBeenCalled();
  });

  it("openFolder 失败 → 显示错误、不 advance", async () => {
    wsMock.openFolder.mockRejectedValue(new Error("boom"));
    const w = mountStep();
    await w.find(".pick-stub").trigger("click");
    await w.find(".confirm-btn").trigger("click");
    await flush();
    expect(w.find(".err").text()).toContain("boom");
    expect(obMock.advance).not.toHaveBeenCalled();
  });

  it("已有激活工作区（activeKey）→ mounted 即自动跳过", () => {
    wsMock.activeKey.value = "existing-key";
    mountStep();
    expect(obMock.advance).toHaveBeenCalled();
  });

  it("getProjectInfo().root 非空（老用户有工作区、activeKey 未恢复）→ 自动跳过", async () => {
    wsMock.activeKey.value = null; // 启动时 activeKey 不从 values.workspace 恢复
    getProjectInfo.fn.mockResolvedValue({ root: "C:/dev/proj", name: "proj", branch: "" } as any);
    mountStep();
    await flush();
    expect(obMock.advance).toHaveBeenCalled();
  });

  it("getProjectInfo().root 为空（全新用户）→ 留在本步、不跳过", async () => {
    wsMock.activeKey.value = null;
    getProjectInfo.fn.mockResolvedValue({ root: null } as any);
    mountStep();
    await flush();
    expect(obMock.advance).not.toHaveBeenCalled();
  });
});