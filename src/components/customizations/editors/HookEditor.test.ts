// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, it, expect } from "vitest";
import HookEditor from "./HookEditor.vue";

const item: any = {
  id: "PostToolUse_0",
  name: "提交检查",
  type: "hook",
  enabled: true,
  path: "",
  source: "user",
  metadata: { event: "PostToolUse", matcher: "^Bash$", command: "echo ok", timeout: 30, asyncRewake: false },
};

describe("HookEditor", () => {
  it("渲染 event 下拉 + matcher + command", () => {
    const w = mount(HookEditor, { props: { item } });
    expect(w.html()).toContain("PostToolUse");
    expect(w.text()).toContain("matcher");
    expect(w.text()).toContain("command");
    const matcherInput = w
      .findAll("input")
      .find((i) => (i.element as HTMLInputElement).value === "^Bash$");
    expect(matcherInput).toBeTruthy();
  });

  it("event 下拉含 4 选项", () => {
    const w = mount(HookEditor, { props: { item } });
    expect(w.findAll("option").length).toBe(4);
  });

  it("内置只读无保存按钮", () => {
    const w = mount(HookEditor, { props: { item: { ...item, source: "builtin" } } });
    expect(w.find("button.save-btn").exists()).toBe(false);
  });
});