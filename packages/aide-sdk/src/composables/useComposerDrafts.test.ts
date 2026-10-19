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

  it("搬迁：定名时跟到正式 id，旧 key 不留", () => {
    d.draftOf("tmp-1").text = "下一条";
    d.migrateDraft("tmp-1", "real-1");
    expect(d.draftOf("real-1").text).toBe("下一条");
    expect(d.draftOf("tmp-1").text).toBe("");
  });

  it("搬迁不覆盖目标已有的内容", () => {
    d.draftOf(blankDraftKey("t1")).text = "空白标签里的";
    d.draftOf("S").text = "S 自己的";
    d.migrateDraft(blankDraftKey("t1"), "S");
    expect(d.draftOf("S").text).toBe("S 自己的");
  });

  it("收口后清空", () => {
    d.draftOf("A").text = "x";
    d.clearDraft("A");
    expect(d.draftOf("A").text).toBe("");
  });
});
