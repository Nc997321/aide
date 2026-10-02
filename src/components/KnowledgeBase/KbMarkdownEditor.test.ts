// @vitest-environment jsdom
// 相对导入而非 `@/`：测试文件被 tsconfig exclude，编辑器会为它们建推断项目，
// 解析不了 `@/` 别名（与同目录其它测试一致）。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { EditorView } from "@codemirror/view";
import KbMarkdownEditor from "./KbMarkdownEditor.vue";

function viewOf(w: ReturnType<typeof mount>): EditorView {
  const v = EditorView.findFromDOM(w.element as HTMLElement);
  if (!v) throw new Error("editor not mounted");
  return v;
}

describe("KbMarkdownEditor", () => {
  it("单栏：只挂一个编辑器，初始内容原样进入", () => {
    const w = mount(KbMarkdownEditor, { props: { modelValue: "# 标题\n\n正文" }, attachTo: document.body });
    expect(w.findAll(".cm-editor")).toHaveLength(1);
    expect(viewOf(w).state.doc.toString()).toBe("# 标题\n\n正文");
    w.unmount();
  });

  it("用户编辑回流 v-model；父层回灌不回流（避免假 dirty）", async () => {
    const w = mount(KbMarkdownEditor, { props: { modelValue: "a" }, attachTo: document.body });
    const v = viewOf(w);

    v.dispatch({ changes: { from: 1, insert: "b" } });
    expect(w.emitted("update:modelValue")?.at(-1)).toEqual(["ab"]);

    const before = w.emitted("update:modelValue")?.length ?? 0;
    await w.setProps({ modelValue: "reset" });
    expect(v.state.doc.toString()).toBe("reset");
    expect(w.emitted("update:modelValue")?.length ?? 0).toBe(before);
    w.unmount();
  });
});
