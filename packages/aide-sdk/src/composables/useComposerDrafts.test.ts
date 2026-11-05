import { beforeEach, describe, expect, it } from "vitest";
import { __resetComposerDraftsForTest, blankDraftKey, useComposerDrafts } from "./useComposerDrafts";

const d = useComposerDrafts();
beforeEach(() => __resetComposerDraftsForTest());

describe("输入框草稿按会话自持", () => {
  it("各会话互不串", () => {
    d.draftOf("A").text = "给 A 的";
    d.draftOf("B").mentions.push({ path: "/x.ts", isDir: false });
    expect(d.draftOf("A").text).toBe("给 A 的");
    expect(d.draftOf("A").mentions).toEqual([]);
    expect(d.draftOf("B").text).toBe("");
    expect(d.draftOf("B").mentions).toHaveLength(1);
  });

  it("搬迁：旧 key 只作为别名指向正式草稿，不产生第二份", () => {
    d.draftOf("tmp-1").text = "下一条";
    d.migrateDraft("tmp-1", "real-1");
    expect(d.draftOf("real-1").text).toBe("下一条");
    expect(d.draftOf("tmp-1")).toBe(d.draftOf("real-1"));
  });

  it("搬迁不覆盖目标已有的内容", () => {
    d.draftOf(blankDraftKey("t1")).text = "空白标签里的";
    d.draftOf("S").text = "S 自己的";
    d.migrateDraft(blankDraftKey("t1"), "S");
    expect(d.draftOf("S").text).toBe("空白标签里的\n\nS 自己的");
    expect(d.existingDraftOf(blankDraftKey("t1"))).toBe(d.draftOf("S"));
  });

  it("收口后清空", () => {
    d.draftOf("A").text = "x";
    d.clearDraft("A");
    expect(d.draftOf("A").text).toBe("");
  });

  it("迁移 alias 可解析到已存在草稿，clear 后只读查询不复活草稿", () => {
    const blank = blankDraftKey("tab");
    d.draftOf(blank).mediaRefs.push({ ref: { source: { path: "a.mp4", title: "a", revision: "r1" }, selection: { kind: "point", atMs: 10 } } });
    d.migrateDraft(blank, "temp");
    d.migrateDraft("temp", "real");
    expect(d.resolveDraftKey(blank)).toBe("real");
    expect(d.existingDraftOf(blank)?.mediaRefs).toHaveLength(1);
    d.clearDraft("real");
    expect(d.existingDraftOf(blank)).toBeUndefined();
  });
});
