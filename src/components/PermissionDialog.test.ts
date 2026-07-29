// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PermissionDialog from "./PermissionDialog.vue";
import type { PermissionRequest } from "../types/chat";

const bashPermission = (): PermissionRequest => ({
  id: "p1",
  name: "Bash",
  input: { command: "ls -la" },
});

describe("PermissionDialog — ordinary tool confirmation", () => {
  it("exposes only deny and allow (no always-allow button)", () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    expect(wrapper.find('[data-action="always-allow"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="allow"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="deny"]').exists()).toBe(true);
  });

  it("emits respond(approved=true) when allow is clicked (no always payload)", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="allow"]').trigger("click");
    const events = wrapper.emitted("respond");
    expect(events).toBeTruthy();
    // [id, approved, answers?, nextMode?] — no `always` slot.
    expect(events![0]).toEqual(["p1", true]);
  });

  it("emits respond(approved=false) when deny is clicked", async () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    await wrapper.get('[data-action="deny"]').trigger("click");
    expect(wrapper.emitted("respond")![0]).toEqual(["p1", false]);
  });
});

describe("PermissionDialog — 允许并记住", () => {
  it("无 rememberScope 时不显示记住按钮", () => {
    const wrapper = mount(PermissionDialog, { props: { permission: bashPermission() } });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
  });

  it("有 rememberScope 且可推导时显示记住按钮 + 描述行", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: bashPermission(), rememberScope: "local" },
    });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
    expect(wrapper.find(".perm-remember-hint").text()).toContain("ls -la");
  });

  it("点击记住按钮 emit 带 persistRule 的 respond", async () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: bashPermission(), rememberScope: "local" },
    });
    await wrapper.get('[data-action="remember"]').trigger("click");
    const events = wrapper.emitted("respond");
    expect(events).toBeTruthy();
    expect(events![0][0]).toBe("p1");
    expect(events![0][1]).toBe(true);
    const persist = events![0][4] as { scope: string; rule: { tool: string; matcher: unknown } };
    expect(persist.scope).toBe("local");
    expect(persist.rule.tool).toBe("Bash");
    expect(persist.rule.matcher).toEqual({ kind: "bash", mode: "prefix", value: "ls -la" });
  });

  it("计划批准不显示记住按钮", () => {
    const wrapper = mount(PermissionDialog, {
      props: {
        permission: { id: "p2", name: "ExitPlanMode", input: { plan: "do X" } },
        rememberScope: "local",
      },
    });
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
  });
});