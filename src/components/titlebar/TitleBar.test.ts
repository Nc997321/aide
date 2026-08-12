// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { shallowMount } from "@vue/test-utils";

// AppLogo 顶层 `import iconUrl from "/icon.png"`（public 资源）在 vitest 下解析成
// file:///icon.png 触发 fs 报错——mock 掉整个模块，跳过其副作用加载。
vi.mock("../AppLogo.vue", () => ({
  default: { name: "AppLogo", template: '<div class="app-logo-stub"/>' },
}));

import TitleBar from "./TitleBar.vue";
import type { RunConfig } from "../../types";
import type { RunStatus } from "../../composables/useRunProcess";

// v-tooltip 在 main.ts 全局注册；单测里给空 stub 指令避免「Failed to resolve」。
const tooltipStub = { mounted() {}, updated() {} };

const cfg: RunConfig = { id: "c1", name: "Cfg1", cwd: "/x", command: "echo hi" };

function mountWith(status: RunStatus) {
  return shallowMount(TitleBar, {
    props: {
      projectName: "demo",
      runConfigs: [cfg],
      activeRunConfig: cfg,
      runStates: { c1: status },
    },
    global: { directives: { tooltip: tooltipStub } },
  });
}

describe("TitleBar 运行/停止/重启按钮显示逻辑", () => {
  it("idle: 仅运行按钮，无停止/重启按钮", () => {
    const w = mountWith("idle");
    expect(w.find(".run-play-btn").exists()).toBe(true);
    expect(w.find(".run-stop-btn").exists()).toBe(false);
    expect(w.find(".run-restart-btn").exists()).toBe(false);
    w.unmount();
  });

  it("running: 停止 + 重启按钮，无运行按钮", () => {
    const w = mountWith("running");
    expect(w.find(".run-stop-btn").exists()).toBe(true);
    expect(w.find(".run-restart-btn").exists()).toBe(true);
    expect(w.find(".run-play-btn").exists()).toBe(false);
    w.unmount();
  });

  it("stopped: 仅运行按钮，重启按钮必须消失（回归）", () => {
    const w = mountWith("stopped");
    expect(w.find(".run-play-btn").exists()).toBe(true);
    expect(w.find(".run-restart-btn").exists()).toBe(false);
    expect(w.find(".run-stop-btn").exists()).toBe(false);
    w.unmount();
  });

  it("crashed: 仅运行按钮，无重启按钮", () => {
    const w = mountWith("crashed");
    expect(w.find(".run-play-btn").exists()).toBe(true);
    expect(w.find(".run-restart-btn").exists()).toBe(false);
    w.unmount();
  });
});