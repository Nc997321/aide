// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

// 避免 /icon.png 资源在 jsdom 下的导入问题，AppLogo 用占位替换
vi.mock("../../AppLogo.vue", () => ({
  default: { name: "AppLogo", template: "<div class='logo-stub'></div>" },
}));

import WelcomeStep from "./WelcomeStep.vue";

describe("WelcomeStep", () => {
  it("渲染 headline + support + 三 pill", () => {
    const w = mount(WelcomeStep);
    expect(w.find(".headline").text()).toContain("和 Claude 并肩写代码");
    expect(w.find(".support").text()).toContain("桌面工作区");
    const pills = w.findAll(".pill");
    expect(pills.length).toBe(3);
    expect(pills[0].text()).toContain("选工作区");
    expect(pills[1].text()).toContain("登录 Claude");
    expect(pills[2].text()).toContain("选模型");
  });

  it("渲染 eyebrow 步号 + logo", () => {
    const w = mount(WelcomeStep);
    expect(w.find(".eyebrow").text()).toContain("01 / 04");
    expect(w.find(".logo-stub").exists()).toBe(true);
  });
});