import { describe, expect, it } from "vitest";
import { KbScopeStore, applySelectionEdit, parseLinked, parseScope, type KbScope } from "./scope.js";
import type { UserMessageBlock } from "../../engine/types.js";

const block = (over: Record<string, unknown> = {}) => ({
  type: "kbref",
  selectionId: "s1",
  documentId: "doc-1",
  title: "发布流程",
  baseVersion: 3,
  start: 6,
  end: 11,
  text: "切流量到旧",
  comment: "写具体些",
  ...over,
});

describe("parseScope", () => {
  it("合法块 → 选区", () => {
    expect(parseScope(block())).toMatchObject({ id: "s1", documentId: "doc-1", start: 6, end: 11, text: "切流量到旧" });
  });
  it.each([
    ["不是 kbref", { type: "mention" }],
    ["缺 selectionId", { selectionId: "" }],
    ["end <= start", { end: 6 }],
    ["偏移与原文长度对不上", { end: 12 }],
    ["原文为空", { text: "", end: 6 }],
    ["偏移为负", { start: -1 }],
    ["偏移非整数", { start: 1.5 }],
  ])("畸形：%s → null", (_name, over) => {
    expect(parseScope(block(over))).toBeNull();
  });
  it("非对象 → null", () => {
    expect(parseScope(null)).toBeNull();
    expect(parseScope("x")).toBeNull();
  });
  it("原文超上限整块丢弃而不是截断", () => {
    const big = "a".repeat(20_001);
    expect(parseScope(block({ text: big, end: 6 + big.length }))).toBeNull();
  });
});

describe("KbScopeStore", () => {
  it("按最新一条消息整表替换；无 kbref 清空", () => {
    const s = new KbScopeStore();
    s.replaceFromDisplay([block()] as unknown as UserMessageBlock[]);
    expect(s.active).toBe(true);
    expect(s.get("s1")?.documentId).toBe("doc-1");
    s.replaceFromDisplay([{ type: "text", text: "继续" }]);
    expect(s.active).toBe(false);
    expect(s.get("s1")).toBeUndefined();
  });
  it("display 缺失也清空", () => {
    const s = new KbScopeStore();
    s.replaceFromDisplay([block()] as unknown as UserMessageBlock[]);
    s.replaceFromDisplay(undefined);
    expect(s.active).toBe(false);
  });
  it("同 id 重复只认第一个；畸形块跳过", () => {
    const s = new KbScopeStore();
    s.replaceFromDisplay([
      block({ text: "切流量到旧" }),
      block({ documentId: "other" }),
      block({ selectionId: "bad", end: 7 }),
    ] as unknown as UserMessageBlock[]);
    expect(s.list()).toHaveLength(1);
    expect(s.get("s1")?.documentId).toBe("doc-1");
  });
  it("最多登记 8 个", () => {
    const s = new KbScopeStore();
    const blocks = Array.from({ length: 12 }, (_, i) => block({ selectionId: `s${i}` }));
    s.replaceFromDisplay(blocks as unknown as UserMessageBlock[]);
    expect(s.list()).toHaveLength(8);
  });
  it("moveTo 把范围挪到新位置，其余字段不变", () => {
    const s = new KbScopeStore();
    s.replaceFromDisplay([block()] as unknown as UserMessageBlock[]);
    s.moveTo("s1", { start: 6, end: 9, text: "新文本", baseVersion: 4 });
    expect(s.get("s1")).toMatchObject({ documentId: "doc-1", comment: "写具体些", start: 6, end: 9, text: "新文本", baseVersion: 4 });
  });
});

describe("applySelectionEdit", () => {
  const content = "出现故障时先切流量到旧版本再排查。\n\n第二段不能动。\n";
  const scope: KbScope = {
    id: "s1", documentId: "d", title: "t", baseVersion: 1, comment: "",
    start: content.indexOf("切流量到旧版本"), end: content.indexOf("切流量到旧版本") + 7, text: "切流量到旧版本",
  };

  it("只改选区：前后两段逐字不变", () => {
    const r = applySelectionEdit(content, scope, "把入口流量全部切回上一个稳定版本");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.slice(0, scope.start)).toBe(content.slice(0, scope.start));
    expect(r.body.endsWith(content.slice(scope.end))).toBe(true);
    expect(r.body).toContain("把入口流量全部切回上一个稳定版本");
    expect(r.body).toContain("第二段不能动。");
    // 新范围恰好覆盖新文本
    expect(r.body.slice(r.start, r.end)).toBe("把入口流量全部切回上一个稳定版本");
  });

  it("新文本为空 = 删除选区，其余不变", () => {
    const r = applySelectionEdit(content, scope, "");
    expect(r.ok && r.body).toBe(content.slice(0, scope.start) + content.slice(scope.end));
  });

  it("新文本里带换行、markdown 也只落在选区内", () => {
    const r = applySelectionEdit(content, scope, "- a\n- b");
    expect(r.ok && r.body.endsWith(content.slice(scope.end))).toBe(true);
  });

  it("选区原文不在原位（文档被改过）→ stale，不写", () => {
    const changed = "新增一句话。" + content;
    expect(applySelectionEdit(changed, scope, "x")).toEqual({ ok: false, reason: "stale" });
  });

  it("范围越界 → stale", () => {
    expect(applySelectionEdit("短", scope, "x")).toEqual({ ok: false, reason: "stale" });
  });
});

describe("关联项目（read_memory 的授权根之一）", () => {
  it("parseLinked：只留非空字符串并去空白；形状不对给空数组", () => {
    expect(parseLinked(block({ linked: [" /a/b ", "", 3, null, "/c"] }))).toEqual(["/a/b", "/c"]);
    expect(parseLinked(block({ linked: "/a" }))).toEqual([]);
    expect(parseLinked(block())).toEqual([]);
    expect(parseLinked(null)).toEqual([]);
  });

  it("随最新一条用户消息整表替换：带圈选的消息给出关联根，之后不带圈选的消息清空（不残留上一轮授权）", () => {
    const s = new KbScopeStore();
    s.replaceFromDisplay([block({ linked: ["/repo/a", "/repo/b"] })] as unknown as UserMessageBlock[]);
    expect(s.linkedRoots()).toEqual(["/repo/a", "/repo/b"]);
    s.replaceFromDisplay([{ type: "text", text: "继续" }]);
    expect(s.linkedRoots()).toEqual([]);
  });

  it("多个选区的关联根取并集去重；畸形选区块不贡献关联根", () => {
    const s = new KbScopeStore();
    s.replaceFromDisplay([
      block({ selectionId: "s1", linked: ["/repo/a"] }),
      block({ selectionId: "s2", linked: ["/repo/a", "/repo/b"] }),
      block({ selectionId: "s3", end: 999, linked: ["/repo/evil"] }), // 偏移与原文对不上 → 整块不登记
    ] as unknown as UserMessageBlock[]);
    expect(s.linkedRoots()).toEqual(["/repo/a", "/repo/b"]);
  });

  it("数量封顶", () => {
    const s = new KbScopeStore();
    const many = Array.from({ length: 20 }, (_, i) => `/repo/${i}`);
    s.replaceFromDisplay([block({ linked: many })] as unknown as UserMessageBlock[]);
    expect(s.linkedRoots()).toHaveLength(8);
  });
});
