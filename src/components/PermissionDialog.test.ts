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

describe("PermissionDialog — 进入编辑模式", () => {
  const editPermission = (): PermissionRequest => ({
    id: "p3",
    name: "Edit",
    input: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
  });

  it("手动模式下编辑工具显示「进入编辑模式」、顶替「允许并记住」", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: editPermission(), rememberScope: "local", currentMode: "default" },
    });
    expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(false);
    expect(wrapper.find(".perm-remember-hint").text()).toContain("编辑模式");
  });

  it("点击「进入编辑模式」emit 带 nextMode=acceptEdits 的放行", async () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: editPermission(), rememberScope: "local", currentMode: "default" },
    });
    await wrapper.get('[data-action="edit-mode"]').trigger("click");
    const events = wrapper.emitted("respond");
    expect(events).toBeTruthy();
    expect(events![0]).toEqual(["p3", true, undefined, "acceptEdits"]);
  });

  it("非编辑工具（Bash）不显示，仍走「允许并记住」", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: bashPermission(), rememberScope: "local", currentMode: "default" },
    });
    expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
  });

  it("已在编辑/自动/最高权限模式时不显示（弹窗属 ask 规则例外，回到记住按钮）", () => {
    for (const mode of ["acceptEdits", "auto", "bypassPermissions"]) {
      const wrapper = mount(PermissionDialog, {
        props: { permission: editPermission(), rememberScope: "local", currentMode: mode },
      });
      expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(false);
      expect(wrapper.find('[data-action="remember"]').exists()).toBe(true);
    }
  });

  it("模式还没就位（空串）时按手动模式处理：显示", () => {
    const wrapper = mount(PermissionDialog, {
      props: { permission: editPermission(), currentMode: "" },
    });
    expect(wrapper.find('[data-action="edit-mode"]').exists()).toBe(true);
  });
});