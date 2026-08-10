// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

// vi.hoisted：mock 状态在 vi.mock 工厂前创建，且每次 useOnboarding() 返回同一对象。
// 用普通 {value} 对象而非 ref——测试直接读 .value 断言，不需要 Vue 响应式重渲染。
const obMock = vi.hoisted(() => ({
  visible: { value: true },
  step: { value: "welcome" },
  advance: vi.fn(),
  back: vi.fn(),
  skipAll: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("../../composables/useOnboarding", () => ({
  useOnboarding: () => obMock,
}));

// AppLogo 导入 /icon.png 在 vitest 下解析为 file:///icon.png 会抛错（真 Vite 构建无此问题），
// 向导测试只验 chrome 不验 step 内容，mock 掉 AppLogo 隔离资源导入。
vi.mock("../AppLogo.vue", () => ({
  default: { name: "AppLogo", template: "<div class='logo-stub'></div>" },
}));

import OnboardingWizard from "./OnboardingWizard.vue";

function mountWizard() {
  return mount(OnboardingWizard, {
    attachTo: document.body,
    global: { stubs: { Teleport: { template: "<div><slot /></div>" } } },
  });
}

describe("OnboardingWizard shell", () => {
  beforeEach(() => {
    obMock.visible.value = true;
    obMock.step.value = "welcome";
    obMock.advance.mockReset();
    obMock.back.mockReset();
    obMock.skipAll.mockReset();
    obMock.complete.mockReset();
    obMock.advance.mockImplementation(() => {
      obMock.step.value = "workspace";
    });
  });

  it("渲染全屏覆盖 + 4 段进度轨 + 跳过引导按钮", () => {
    const w = mountWizard();
    expect(w.find(".onboarding-overlay").exists()).toBe(true);
    expect(w.findAll(".rail .seg").length).toBe(4);
    expect(w.find(".skip-all").exists()).toBe(true);
  });

  it("welcome 步只显示「开始」、不显示「上一步」", () => {
    const w = mountWizard();
    expect(w.find(".btn-primary").text()).toContain("开始");
    expect(w.find(".btn-back").exists()).toBe(false);
  });

  it("点「跳过引导」调 skipAll", async () => {
    const w = mountWizard();
    await w.find(".skip-all").trigger("click");
    expect(obMock.skipAll).toHaveBeenCalled();
  });

  it("点「开始」调 advance（推进到 workspace）", async () => {
    const w = mountWizard();
    await w.find(".btn-primary").trigger("click");
    expect(obMock.advance).toHaveBeenCalled();
    expect(obMock.step.value).toBe("workspace");
  });

  it("非 welcome 步显示「上一步」按钮，点击调 back", async () => {
    obMock.step.value = "workspace";
    const w = mountWizard();
    const backBtn = w.find(".btn-back");
    expect(backBtn.exists()).toBe(true);
    await backBtn.trigger("click");
    expect(obMock.back).toHaveBeenCalled();
  });

  it("model 步主按钮文案为「进入 aide」，点击调 complete", async () => {
    obMock.step.value = "model";
    const w = mountWizard();
    expect(w.find(".btn-primary").text()).toContain("进入 aide");
    await w.find(".btn-primary").trigger("click");
    expect(obMock.complete).toHaveBeenCalled();
  });
});