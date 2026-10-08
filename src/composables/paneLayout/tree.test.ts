import { describe, it, expect } from "vitest";
import {
  createEmptyRoot,
  createGroup,
  createTab,
  findTabBySession,
  listGroups,
  listSnapshotTabs,
  normalize,
  parseSnapshot,
  removeTab,
  restoreSnapshot,
  setSplitSizes,
  splitGroup,
  toSnapshot,
  type GroupNode,
  type PaneNode,
  type SplitNode,
} from "./tree";

/** 便捷构造：带 n 个会话 tab 的组 */
function groupWith(...sids: string[]): GroupNode {
  return createGroup(sids.map((s) => createTab(s)));
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** 断言全树不变量：无空组、无单孩子 split、无同方向嵌套、sizes 归一、组内引用有效 */
function assertInvariants(root: PaneNode) {
  const walk = (n: PaneNode, parentDir?: string) => {
    if (n.type === "group") {
      expect(n.tabs.length).toBeGreaterThan(0);
      if (n.activeTabId) expect(n.tabs.some((t) => t.id === n.activeTabId)).toBe(true);
      if (n.previewTabId) expect(n.tabs.some((t) => t.id === n.previewTabId)).toBe(true);
      return;
    }
    expect(n.children.length).toBeGreaterThanOrEqual(2);
    expect(n.direction).not.toBe(parentDir);
    expect(n.sizes.length).toBe(n.children.length);
    expect(sum(n.sizes)).toBeCloseTo(1, 6);
    n.children.forEach((c) => walk(c, n.direction));
  };
  walk(root);
}

describe("normalize 树不变量", () => {
  it("空组被剔除，split 只剩一个孩子时拍平", () => {
    const keep = groupWith("a");
    const empty = createGroup([]);
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [keep, empty], sizes: [0.5, 0.5],
    };
    const out = normalize(root);
    expect(out).toBe(keep);
  });

  it("同方向嵌套 split 并入父级：格数变了，整排均分", () => {
    const inner: SplitNode = {
      type: "split", id: "inner", direction: "horizontal",
      children: [groupWith("b"), groupWith("c")], sizes: [0.5, 0.5],
    };
    const root: SplitNode = {
      type: "split", id: "outer", direction: "horizontal",
      children: [groupWith("a"), inner], sizes: [0.5, 0.5],
    };
    const out = normalize(root)!;
    expect(out.type).toBe("split");
    expect((out as SplitNode).children).toHaveLength(3);
    expect((out as SplitNode).sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
    assertInvariants(out);
  });

  it("异方向嵌套保留", () => {
    const inner: SplitNode = {
      type: "split", id: "inner", direction: "vertical",
      children: [groupWith("b"), groupWith("c")], sizes: [0.5, 0.5],
    };
    const root: SplitNode = {
      type: "split", id: "outer", direction: "horizontal",
      children: [groupWith("a"), inner], sizes: [0.5, 0.5],
    };
    const out = normalize(root)!;
    expect((out as SplitNode).children).toHaveLength(2);
    assertInvariants(out);
  });

  it("整棵树空了返回 null", () => {
    expect(normalize(createGroup([]))).toBeNull();
  });

  it("非法 sizes（NaN/负数/长度不符）被重置为均分", () => {
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [groupWith("a"), groupWith("b")], sizes: [NaN, -1],
    };
    const out = normalize(root)! as SplitNode;
    expect(out.sizes).toEqual([0.5, 0.5]);
  });
});

describe("removeTab", () => {
  it("关掉激活 tab 后右邻接替；右邻不存在取左邻", () => {
    const g = groupWith("a", "b", "c");
    g.activeTabId = g.tabs[1].id;
    let root = removeTab(g, g.id, g.tabs[1].id)! as GroupNode;
    expect(root.activeTabId).toBe(root.tabs[1].id); // 原 c 顶上
    root.activeTabId = root.tabs[1].id;
    root = removeTab(root, root.id, root.tabs[1].id)! as GroupNode;
    expect(root.activeTabId).toBe(root.tabs[0].id); // 只剩 a
  });

  it("组内最后一个 tab 被关：组随之消失，split 拍平", () => {
    const left = groupWith("a");
    const right = groupWith("b");
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [left, right], sizes: [0.5, 0.5],
    };
    const out = removeTab(root, right.id, right.tabs[0].id);
    expect(out).toBe(left);
  });

  it("关掉预览 tab 清空 previewTabId", () => {
    const g = groupWith("a", "b");
    g.previewTabId = g.tabs[0].id;
    const out = removeTab(g, g.id, g.tabs[0].id)! as GroupNode;
    expect(out.previewTabId).toBeNull();
  });
});

describe("splitGroup", () => {
  it("多 tab 组拆分：激活 tab 移入新组，旧组引用修复", () => {
    const g = groupWith("a", "b");
    g.activeTabId = g.tabs[1].id;
    const res = splitGroup(g, g.id, "horizontal", true)!;
    assertInvariants(res.root);
    expect(res.newGroup.tabs.map((t) => t.sessionId)).toEqual(["b"]);
    expect((res.root as SplitNode).children).toEqual([g, res.newGroup]);
    expect(g.tabs.map((t) => t.sessionId)).toEqual(["a"]);
    expect(g.activeTabId).toBe(g.tabs[0].id);
  });

  it("单 tab 组拆分：新组给空白预览 tab（不搬空旧组）", () => {
    const g = groupWith("a");
    const res = splitGroup(g, g.id, "vertical", true)!;
    expect(g.tabs).toHaveLength(1);
    expect(res.newGroup.tabs).toHaveLength(1);
    expect(res.newGroup.tabs[0].sessionId).toBeNull();
    expect(res.newGroup.previewTabId).toBe(res.newGroup.tabs[0].id);
    assertInvariants(res.root);
  });

  it("父 split 同方向：原地插一列、整排均分（手动比例作废），不产生嵌套", () => {
    const a = groupWith("a", "x");
    const b = groupWith("b");
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [a, b], sizes: [0.6, 0.4],
    };
    const res = splitGroup(root, a.id, "horizontal", true)!;
    expect(res.root).toBe(root);
    expect(root.children).toHaveLength(3);
    expect(root.children[1]).toBe(res.newGroup);
    expect(root.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
    assertInvariants(res.root);
  });

  it("异方向拆分产生嵌套 split", () => {
    const a = groupWith("a", "x");
    const b = groupWith("b");
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [a, b], sizes: [0.5, 0.5],
    };
    const res = splitGroup(root, a.id, "vertical", true)!;
    const nested = (res.root as SplitNode).children[0] as SplitNode;
    expect(nested.type).toBe("split");
    expect(nested.direction).toBe("vertical");
    assertInvariants(res.root);
  });

  it("moveActiveTab=false 返回空新组（调用方立刻填 tab 的约定）", () => {
    const g = groupWith("a");
    const res = splitGroup(g, g.id, "horizontal", false)!;
    expect(res.newGroup.tabs).toHaveLength(0);
    expect(g.tabs).toHaveLength(1);
  });
});

describe("分屏均分（格数变了整排均分）", () => {
  it("连拆两次 → 三格各 1/3（不是 1/2、1/4、1/4）", () => {
    const a = groupWith("a", "x", "y");
    const first = splitGroup(a, a.id, "horizontal", true)!;
    const second = splitGroup(first.root, first.newGroup.id, "horizontal", false)!;
    second.newGroup.tabs.push(createTab("z"));
    const root = second.root as SplitNode;
    expect(root.children).toHaveLength(3);
    expect(root.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("手动拖过的三格关掉一格 → 剩下两格各 1/2", () => {
    const a = groupWith("a");
    const b = groupWith("b");
    const c = groupWith("c");
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [a, b, c], sizes: [0.6, 0.3, 0.1],
    };
    const out = removeTab(root, c.id, c.tabs[0].id) as SplitNode;
    expect(out.sizes).toEqual([0.5, 0.5]);
    assertInvariants(out);
  });

  it("格数没变（组内关一个 tab）→ 手动比例保留", () => {
    const a = groupWith("a", "a2");
    const b = groupWith("b");
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [a, b], sizes: [0.7, 0.3],
    };
    const out = removeTab(root, a.id, a.tabs[1].id) as SplitNode;
    expect(out.sizes).toEqual([0.7, 0.3]);
  });

  it("异方向的另一排不受影响", () => {
    const inner: SplitNode = {
      type: "split", id: "inner", direction: "vertical",
      children: [groupWith("b"), groupWith("c"), groupWith("d")], sizes: [0.2, 0.3, 0.5],
    };
    const root: SplitNode = {
      type: "split", id: "outer", direction: "horizontal",
      children: [groupWith("a"), inner], sizes: [0.7, 0.3],
    };
    const d = inner.children[2] as GroupNode;
    const out = removeTab(root, d.id, d.tabs[0].id) as SplitNode;
    expect(out.sizes).toEqual([0.7, 0.3]); // 外排格数没变
    expect((out.children[1] as SplitNode).sizes).toEqual([0.5, 0.5]); // 内排少一格 → 均分
  });

  it("空白组不入快照 → 快照里那一排均分", () => {
    const a = groupWith("a");
    const b = groupWith("b");
    const blank = createGroup([createTab(null)]);
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [a, b, blank], sizes: [0.6, 0.2, 0.2],
    };
    const snap = toSnapshot(root, a.id)!;
    expect((snap.root as { sizes: number[] }).sizes).toEqual([0.5, 0.5]);
  });
});

describe("setSplitSizes", () => {
  it("正常写回并归一化", () => {
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [groupWith("a"), groupWith("b")], sizes: [0.5, 0.5],
    };
    setSplitSizes(root, "s", [3, 1]);
    expect(root.sizes).toEqual([0.75, 0.25]);
  });

  it("长度不符 / 非法值一律忽略", () => {
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [groupWith("a"), groupWith("b")], sizes: [0.5, 0.5],
    };
    setSplitSizes(root, "s", [1]);
    expect(root.sizes).toEqual([0.5, 0.5]);
  });
});

describe("快照序列化与恢复", () => {
  function sampleTree(): { root: SplitNode; focusId: string } {
    const left = groupWith("a", "b");
    left.activeTabId = left.tabs[1].id;
    const right = groupWith("c");
    const root: SplitNode = {
      type: "split", id: "s", direction: "horizontal",
      children: [left, right], sizes: [0.7, 0.3],
    };
    return { root, focusId: right.id };
  }

  it("toSnapshot→restoreSnapshot 往返保结构、激活项、聚焦组、尺寸", () => {
    const { root, focusId } = sampleTree();
    const snap = toSnapshot(root, focusId)!;
    const back = restoreSnapshot(snap)!;
    assertInvariants(back.root);
    const groups = listGroups(back.root);
    expect(groups).toHaveLength(2);
    expect(groups[0].tabs.map((t) => t.sessionId)).toEqual(["a", "b"]);
    expect(groups[0].activeTabId).toBe(groups[0].tabs[1].id);
    expect(back.focusedGroupId).toBe(groups[1].id);
    expect((back.root as SplitNode).sizes).toEqual([0.7, 0.3]);
    // 恢复的 tab 一律非预览
    groups.forEach((g) => expect(g.previewTabId).toBeNull());
  });

  it("空白 tab 不入快照；全空白布局返回 null", () => {
    expect(toSnapshot(createEmptyRoot(), "x")).toBeNull();
    const g = groupWith("a");
    g.tabs.push(createTab(null, "草稿"));
    const snap = toSnapshot(g, g.id)!;
    expect(snap.root).toEqual({ type: "group", tabs: [{ sessionId: "a" }], active: 0 });
  });

  it("v2：meta 解析器把名字/工作区归属写进快照，restore 后 listSnapshotTabs 可取回", () => {
    const g = groupWith("a", "b");
    const snap = toSnapshot(g, g.id, (sid) =>
      sid === "a" ? { name: "会话A", wsKey: "C--proj", wsPath: "C:\\proj" } : {},
    )!;
    const tabs = listSnapshotTabs(snap);
    expect(tabs).toEqual([
      { sessionId: "a", name: "会话A", wsKey: "C--proj", wsPath: "C:\\proj" },
      { sessionId: "b" },
    ]);
    // 经 parse 往返不丢字段
    const reparsed = parseSnapshot(JSON.parse(JSON.stringify(snap)))!;
    expect(listSnapshotTabs(reparsed)).toEqual(tabs);
  });

  it("restore 剔除无效会话，组空则连组消失", () => {
    const { root, focusId } = sampleTree();
    const snap = toSnapshot(root, focusId)!;
    const back = restoreSnapshot(snap, new Set(["a", "b"]))!;
    const groups = listGroups(back.root);
    expect(groups).toHaveLength(1);
    expect(groups[0].tabs.map((t) => t.sessionId)).toEqual(["a", "b"]);
  });

  it("restore 全局去重：同一会话出现两次保首个", () => {
    const snap = parseSnapshot({
      version: 2,
      focusedGroup: 0,
      root: {
        type: "split", direction: "horizontal", sizes: [0.5, 0.5],
        children: [
          { type: "group", tabs: [{ sessionId: "a" }], active: 0 },
          { type: "group", tabs: [{ sessionId: "a" }, { sessionId: "b" }], active: 0 },
        ],
      },
    })!;
    const back = restoreSnapshot(snap)!;
    const sids = listGroups(back.root).flatMap((g) => g.tabs.map((t) => t.sessionId));
    expect(sids).toEqual(["a", "b"]);
  });

  it("全部会话失效 → 返回 null（调用方回退空白）", () => {
    const { root, focusId } = sampleTree();
    const snap = toSnapshot(root, focusId)!;
    expect(restoreSnapshot(snap, new Set())).toBeNull();
  });

  it("focusedGroup 下标越界被钳到最后一组", () => {
    const snap = parseSnapshot({
      version: 2, focusedGroup: 99,
      root: { type: "group", tabs: [{ sessionId: "a" }], active: 0 },
    })!;
    const back = restoreSnapshot(snap)!;
    expect(back.focusedGroupId).toBe(listGroups(back.root)[0].id);
  });
});

describe("parseSnapshot 防御式校验", () => {
  const tabA = { sessionId: "a" };
  const bad: unknown[] = [
    null,
    42,
    "{}",
    {},
    // v1（按工作区分份的旧格式，tabs 是字符串数组）整体作废
    { version: 1, focusedGroup: 0, root: { type: "group", tabs: ["a"], active: 0 } },
    { version: 3, focusedGroup: 0, root: { type: "group", tabs: [tabA], active: 0 } },
    { version: 2, focusedGroup: -1, root: { type: "group", tabs: [tabA], active: 0 } },
    { version: 2, focusedGroup: 0, root: { type: "group", tabs: [], active: 0 } },
    { version: 2, focusedGroup: 0, root: { type: "group", tabs: [{ sessionId: "" }], active: 0 } },
    { version: 2, focusedGroup: 0, root: { type: "group", tabs: [tabA], active: "x" } },
    { version: 2, focusedGroup: 0, root: { type: "split", direction: "diagonal", sizes: [1], children: [] } },
    { version: 2, focusedGroup: 0, root: { type: "split", direction: "horizontal", sizes: [1], children: [{ type: "group", tabs: [tabA], active: 0 }] } },
    { version: 2, focusedGroup: 0, root: { type: "nope" } },
  ];

  it.each(bad.map((v, i) => [i, v] as const))("非法输入 #%i → null", (_i, v) => {
    expect(parseSnapshot(v)).toBeNull();
  });

  it("合法输入解析成功，缺失/非法 sizes 均分", () => {
    const snap = parseSnapshot({
      version: 2, focusedGroup: 0,
      root: {
        type: "split", direction: "vertical", sizes: ["x", null],
        children: [
          { type: "group", tabs: [{ sessionId: "a" }], active: 0 },
          { type: "group", tabs: [{ sessionId: "b" }], active: 5 },
        ],
      },
    });
    expect(snap).not.toBeNull();
    expect((snap!.root as { sizes: number[] }).sizes).toEqual([0.5, 0.5]);
  });

  it("超深嵌套（防御上限）→ null", () => {
    let node: Record<string, unknown> = { type: "group", tabs: [{ sessionId: "a" }], active: 0 };
    for (let i = 0; i < 40; i++) {
      node = {
        type: "split",
        direction: i % 2 ? "horizontal" : "vertical",
        sizes: [0.5, 0.5],
        children: [node, { type: "group", tabs: [{ sessionId: `s${i}` }], active: 0 }],
      };
    }
    expect(parseSnapshot({ version: 2, focusedGroup: 0, root: node })).toBeNull();
  });
});

describe("findTabBySession", () => {
  it("跨组命中，未命中返回 null", () => {
    const { root } = (() => {
      const left = groupWith("a");
      const right = groupWith("b");
      const r: SplitNode = {
        type: "split", id: "s", direction: "horizontal",
        children: [left, right], sizes: [0.5, 0.5],
      };
      return { root: r };
    })();
    expect(findTabBySession(root, "b")!.tab.sessionId).toBe("b");
    expect(findTabBySession(root, "zzz")).toBeNull();
  });
});
