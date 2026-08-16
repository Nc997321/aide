// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PermissionScopeTabs from "./PermissionScopeTabs.vue";
import type { ScopeAvailability } from "@/types/permissions";

function scopes(projectEditable = false): ScopeAvailability[] {
  return [
    { scope: "user", editable: true, reason: "", storagePath: "/home/.aide/settings.json", description: "对所有工作区生效" },
    { scope: "project", editable: projectEditable, reason: projectEditable ? "" : "尚未打开项目", storagePath: projectEditable ? "/proj/.aide/settings.json" : null, description: "适合提交到 Git" },
    { scope: "local", editable: projectEditable, reason: projectEditable ? "" : "尚未打开项目", storagePath: projectEditable ? "/proj/.aide/settings.local.json" : null, description: "仅本机" },
    { scope: "managed", editable: false, reason: "受管策略只读", storagePath: "/managed/settings.json", description: "管理员配置" },
  ];
}

describe("PermissionScopeTabs", () => {
  it("disables an unavailable project scope and surfaces the server reason", () => {
    const wrapper = mount(PermissionScopeTabs, {
      props: { scopes: scopes(false), modelValue: "user" },
    });
    const project = wrapper.get('[data-scope="project"]');
    expect(project.attributes("disabled")).toBeDefined();
    // managed is always disabled
    expect(wrapper.get('[data-scope="managed"]').attributes("disabled")).toBeDefined();
    // user is enabled
    expect(wrapper.get('[data-scope="user"]').attributes("disabled")).toBeUndefined();
  });

  it("renders the fixed tab order regardless of input order", () => {
    const scrambled: ScopeAvailability[] = [
      scopes()[3], scopes()[2], scopes()[1], scopes()[0],
    ];
    const wrapper = mount(PermissionScopeTabs, {
      props: { scopes: scrambled, modelValue: "user" },
    });
    const labels = wrapper.findAll(".scope-tab").map((w) => w.text());
    expect(labels).toEqual(["用户全局", "项目共享", "项目本地", "受管策略"]);
  });

  it("emits update:modelValue only when clicking an editable tab", async () => {
    const wrapper = mount(PermissionScopeTabs, {
      props: { scopes: scopes(true), modelValue: "user" },
    });
    await wrapper.get('[data-scope="project"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")?.[0]?.[0]).toBe("project");
  });

  it("does not emit when clicking a disabled tab", async () => {
    const wrapper = mount(PermissionScopeTabs, {
      props: { scopes: scopes(false), modelValue: "user" },
    });
    await wrapper.get('[data-scope="project"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});