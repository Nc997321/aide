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