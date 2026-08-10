// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi } from "vitest";
import InstructionEditor from "./InstructionEditor.vue";

vi.mock("../../../api/customization", () => ({
  instructionApi: {
    getGlobal: vi.fn().mockResolvedValue({ id: "global", metadata: { content: "# 全局指令" } }),
    saveGlobal: vi.fn().mockResolvedValue(undefined),
    getProject: vi.fn().mockResolvedValue({ id: "project", metadata: { content: "# 项目指令" } }),
    saveProject: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("InstructionEditor", () => {
  it("默认全局，切项目加载项目内容", async () => {
    const w = mount(InstructionEditor, { props: { item: null } });
    expect(w.text()).toContain("全局");
    const projBtn = w.findAll("button").find((b) => b.text().includes("项目"))!;
    await projBtn.trigger("click");
    await flushPromises();
    const ta = w.find("textarea.cm-mock");
    expect((ta.element as HTMLTextAreaElement).value).toContain("# 项目指令");
  });

  it("保存调对应 save", async () => {
    const { instructionApi } = await import("../../../api/customization");
    const w = mount(InstructionEditor, { props: { item: null } });
    await w.find("button.save-btn").trigger("click");
    await flushPromises();
    expect(instructionApi.saveGlobal).toHaveBeenCalled();
  });
});