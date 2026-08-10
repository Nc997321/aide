// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { describe, it, expect, vi } from "vitest";
import SkillEditor from "./SkillEditor.vue";

vi.mock("../../../api/customization", () => ({
  customizationApi: { update: vi.fn().mockResolvedValue(undefined) },
  getSkillContent: vi.fn().mockResolvedValue("---\nname: build\n---\n# build\nbody"),
  skillScriptApi: {
    read: vi.fn().mockResolvedValue("echo hi"),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));

const item: any = {
  id: "build",
  name: "build",
  type: "skill",
  enabled: true,
  path: "",
  source: "user",
  description: "构建验证",
  metadata: { scripts: ["build.sh", "check.py"] },
};

describe("SkillEditor", () => {
  it("三 tab：基本信息/正文/脚本", () => {
    const w = mount(SkillEditor, { props: { item } });
    expect(w.text()).toContain("基本信息");
    expect(w.text()).toContain("正文");
    expect(w.text()).toContain("脚本");
  });

  it("脚本 tab 列出 metadata.scripts", async () => {
    const w = mount(SkillEditor, { props: { item } });
    const scriptTab = w.findAll("button").find((b) => b.text().includes("脚本"))!;
    await scriptTab.trigger("click");
    expect(w.text()).toContain("build.sh");
    expect(w.text()).toContain("check.py");
  });

  it("选中脚本加载内容", async () => {
    const w = mount(SkillEditor, { props: { item } });
    await w.findAll("button").find((b) => b.text().includes("脚本"))!.trigger("click");
    await w.find(".script-chip").trigger("click");
    await flushPromises();
    const ta = w
      .findAll("textarea")
      .find((t) => (t.element as HTMLTextAreaElement).value.includes("echo hi"));
    expect(ta).toBeTruthy();
  });

  it("插件来源只读", () => {
    const w = mount(SkillEditor, { props: { item: { ...item, source: "plugin" } } });
    expect(w.find("button.save-btn").exists()).toBe(false);
  });
});