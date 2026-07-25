import { describe, it, expect } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import { parentSyncAnnotation, isUserEdit } from "./cmModelSync";

describe("cmModelSync：父层 v-model 同步不算用户编辑", () => {
  // 根因 pin 住：CodeMirror 文档内部一律 \n 行尾。磁盘 CRLF 原文同步进编辑器后，
  // 若把 doc.toString() 回流 v-model，editContent(LF) ≠ 磁盘基线(CRLF) → 假 dirty。
  it("CodeMirror 会把插入文本的 CRLF 归一化为 LF（假 dirty 的机制根因）", () => {
    const state = EditorState.create({ doc: "a\r\nb\r\n" });
    const tr = state.update({
      changes: { from: 0, to: state.doc.length, insert: "x\r\ny\r\n" },
    });
    expect(tr.state.doc.toString()).toBe("x\ny\n");
  });

  it("带 parentSync 注解的事务 → isUserEdit 为 false（禁止回流 v-model）", () => {
    const state = EditorState.create({ doc: "old" });
    const tr = state.update({
      changes: { from: 0, to: 3, insert: "new" },
      annotations: parentSyncAnnotation.of(true),
    });
    expect(isUserEdit([tr])).toBe(false);
  });

  it("无注解的事务（用户真实编辑）→ isUserEdit 为 true", () => {
    const state = EditorState.create({ doc: "old" });
    const tr = state.update({ changes: { from: 3, insert: "!" } });
    expect(isUserEdit([tr])).toBe(true);
  });

  it("端到端语义：父层同步 CRLF 原文后模型不被归一化文本污染（不假 dirty）", () => {
    const diskBaseline = "line1\r\nline2\r\n";
    let model = diskBaseline; // v-model（editContent）
    const state = EditorState.create({ doc: model });

    // 与组件 updateListener 相同的回流判定：docChanged 且用户编辑才写回
    const echo = (tr: Transaction) => {
      if (tr.docChanged && isUserEdit([tr])) model = tr.state.doc.toString();
    };

    // 父层同步（组件 modelValue watcher 的 dispatch）——带注解
    echo(
      state.update({
        changes: { from: 0, to: state.doc.length, insert: model },
        annotations: parentSyncAnnotation.of(true),
      }),
    );
    expect(model).toBe(diskBaseline); // 未被污染

    // 对照：用户真实编辑必须正常回流
    const userTr = state.update({ changes: { from: 0, insert: "// " } });
    echo(userTr);
    expect(model).toBe(userTr.state.doc.toString());
  });
});
