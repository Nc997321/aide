// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PermissionRuleEditor from "./PermissionRuleEditor.vue";
import type { PermissionRuleDraft } from "@/types/permissions";

const stubs = { ThemedSelect: true };

describe("PermissionRuleEditor", () => {
  it("rejects unsafe Bash contains + allow before submit (no submit emitted, error shown)", async () => {
    const initial: PermissionRuleDraft = {
      effect: "allow",
      tool: "Bash",
      matcher: { kind: "bash", mode: "contains", value: "rm" },
    };
    const wrapper = mount(PermissionRuleEditor, { props: { initial }, global: { stubs } });
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeFalsy();
    expect(wrapper.text()).toContain("「包含文本」不能用于始终允许 Bash");
  });

  it("allows Bash contains + deny (contains is valid for ask/deny)", async () => {
    const initial: PermissionRuleDraft = {
      effect: "deny",
      tool: "Bash",
      matcher: { kind: "bash", mode: "contains", value: "rm -rf" },
    };
    const wrapper = mount(PermissionRuleEditor, { props: { initial }, global: { stubs } });
    await wrapper.get("form").trigger("submit");
    expect(wrapper.emitted("submit")).toBeTruthy();
  });

  it("emits a normalized draft on a valid prefix allow submit", async () => {
    const initial: PermissionRuleDraft = {
      effect: "allow",
      tool: "Bash",
      matcher: { kind: "bash", mode: "prefix", value: "pnpm test" },
    };
    const wrapper = mount(PermissionRuleEditor, { props: { initial }, global: { stubs } });
    await wrapper.get("form").trigger("submit");
    const submit = wrapper.emitted("submit");
    expect(submit).toBeTruthy();
    const emitted = submit![0][0] as PermissionRuleDraft;
    expect(emitted).toEqual({
      effect: "allow",
      tool: "Bash",
      matcher: { kind: "bash", mode: "prefix", value: "pnpm test" },
    });
  });

  it("emits cancel when the cancel button is clicked", async () => {
    const initial: PermissionRuleDraft = {
      effect: "ask", tool: "Read", matcher: { kind: "tool" },
    };
    const wrapper = mount(PermissionRuleEditor, { props: { initial }, global: { stubs } });
    await wrapper.get('button[type="button"]').trigger("click");
    expect(wrapper.emitted("cancel")).toBeTruthy();
  });
});