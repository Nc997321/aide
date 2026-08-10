// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi } from "vitest";
import AgentEditor from "./AgentEditor.vue";

vi.mock("../../../api/customization", () => ({
  customizationApi: { update: vi.fn().mockResolvedValue(undefined) },
  getAgentContent: vi.fn().mockResolvedValue(
    "---\nname: code-reviewer\ndescription: 代码审查\nmodel: claude-sonnet-5\ntools: Read, Grep, Bash\n---\n# code-reviewer\nbody",
  ),
}));

const item: any = {
  id: "code-reviewer",
  name: "code-reviewer",
  type: "agent",
  enabled: true,
  path: "",
  source: "user",
  description: "代码审查",
};

describe("AgentEditor", () => {
  it("基本信息 tab 渲染 model/tools", () => {
    const w = mount(AgentEditor, { props: { item } });
    expect(w.text()).toContain("model");
    expect(w.text()).toContain("tools");
  });

  it("两 tab：基本信息/正文", () => {
    const w = mount(AgentEditor, { props: { item } });
    expect(w.text()).toContain("基本信息");
    expect(w.text()).toContain("正文");
  });

  it("正文 tab 加载全文", async () => {
    const w = mount(AgentEditor, { props: { item } });
    await w.findAll("button").find((b) => b.text().includes("正文"))!.trigger("click");
    await flushPromises();
    const ta = w
      .findAll("textarea")
      .find((t) => (t.element as HTMLTextAreaElement).value.includes("code-reviewer"));
    expect(ta).toBeTruthy();
  });

  it("插件来源只读", () => {
    const w = mount(AgentEditor, { props: { item: { ...item, source: "plugin" } } });
    expect(w.find("button.save-btn").exists()).toBe(false);
  });
});