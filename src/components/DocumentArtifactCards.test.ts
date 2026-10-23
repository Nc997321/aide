// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { open } = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("@/composables/useFileViewer", () => ({ useFileViewer: () => ({ open }) }));
import DocumentArtifactCards from "./DocumentArtifactCards.vue";

describe("文档成果卡片", () => {
  beforeEach(() => vi.clearAllMocks());
  it("标题摘要按纯文本展示，点击复用准确路径的文件弹窗", async () => {
    const w = mount(DocumentArtifactCards, { props: {
      workspacePath: "/project",
      documents: [{ version: 1, path: "docs/设计 方案.md", title: "<b>方案</b>", summary: "<script>bad()</script>" }],
    } });
    expect(w.text()).toContain("<b>方案</b>");
    expect(w.find("script").exists()).toBe(false);
    expect(w.text()).not.toContain("已写入");
    await w.get("button").trigger("click");
    expect(open).toHaveBeenCalledWith("/project/docs/设计 方案.md", { refreshIfClean: true });
    w.unmount();
  });

  it("缺少会话工作区时不把相对路径交给活动工作区", async () => {
    const w = mount(DocumentArtifactCards, { props: { documents: [{ version: 1, path: "docs/a.md", title: "方案" }] } });
    await w.get("button").trigger("click");
    expect(open).not.toHaveBeenCalled();
    expect(w.get('[role="alert"]').text()).toContain("工作区");
    w.unmount();
  });

  it("绝对路径无需工作区，异常明确显示", async () => {
    open.mockRejectedValueOnce(new Error("read failed"));
    const w = mount(DocumentArtifactCards, { props: { documents: [{ version: 1, path: "/project/a.md", title: "方案" }] } });
    await w.get("button").trigger("click");
    expect(open).toHaveBeenCalledWith("/project/a.md", { refreshIfClean: true });
    expect(w.get('[role="alert"]').text()).toContain("read failed");
    w.unmount();
  });
});
