import { describe, it, expect, beforeEach } from "vitest";
import { usePaneLayout, __resetPaneLayoutForTest } from "./usePaneLayout";
import { listGroups, listSnapshotTabs, type GroupNode, type SplitNode } from "./paneLayout/tree";
import { useSessionNames } from "./useSessionNames";
import { useSessionWorkspaces } from "./useSessionWorkspaces";

/** 「已启动」判定注入：测试里显式指定哪些会话算已启动 */
const started = new Set<string>();

function groups() {
  return listGroups(usePaneLayout().layout.root);
}

function focused(): GroupNode {
  const pl = usePaneLayout();
  return groups().find((g) => g.id === pl.layout.focusedGroupId)!;
}

beforeEach(() => {
  started.clear();
  __resetPaneLayoutForTest((sid) => started.has(sid));
});

describe("预览 tab 语义（用户确认的行为）", () => {
  it("初始是空根组（零会话欢迎态），activeSessionId 为空串", () => {
    const pl = usePaneLayout();
    expect(groups()).toHaveLength(1);
    expect(focused().tabs).toHaveLength(0);
    expect(focused().previewTabId).toBeNull();
    expect(pl.activeSessionId.value).toBe("");
  });

  it("点未启动会话：覆盖现有预览 tab，不新增", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    expect(focused().tabs).toHaveLength(1);
    expect(pl.activeSessionId.value).toBe("s1");
    pl.openSession("s2"); // 再点另一个未启动 → 还是覆盖
    expect(focused().tabs).toHaveLength(1);
    expect(pl.activeSessionId.value).toBe("s2");
  });

  it("预览会话启动转正后，下个未启动会话新增预览 tab（边界：聚焦 tab 已启动时新增而非覆盖）", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    started.add("s1");
    pl.promoteTab("s1");
    expect(focused().previewTabId).toBeNull();
    pl.openSession("s2");
    expect(focused().tabs).toHaveLength(2);
    expect(focused().previewTabId).toBe(focused().tabs[1].id);
    expect(pl.activeSessionId.value).toBe("s2");
    // s1 的固定 tab 原样健在
    expect(focused().tabs[0].sessionId).toBe("s1");
  });

  it("点已启动会话：直接开固定 tab，预览 tab 不受影响", () => {
    const pl = usePaneLayout();
    pl.openSession("preview-target");
    started.add("hot");
    pl.openSession("hot");
    expect(focused().tabs).toHaveLength(2);
    const hotTab = focused().tabs.find((t) => t.sessionId === "hot")!;
    expect(focused().previewTabId).not.toBe(hotTab.id);
    expect(focused().tabs.some((t) => t.sessionId === "preview-target")).toBe(true);
  });

  it("openBlankTab：复用预览 tab 并记下 pendingName", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    pl.openBlankTab("新会话 A");
    expect(focused().tabs).toHaveLength(1);
    expect(focused().tabs[0].sessionId).toBeNull();
    expect(focused().tabs[0].pendingName).toBe("新会话 A");
  });
});

describe("全局唯一", () => {
  it("点已打开的会话：聚焦过去，不新开不覆盖（跨组同样）", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    started.add("s1");
    pl.promoteTab("s1");
    pl.openSessionInSplit("s2", "horizontal"); // s2 开在右组
    expect(groups()).toHaveLength(2);
    expect(pl.layout.focusedGroupId).toBe(groups()[1].id);
    pl.openSession("s1"); // 回点左组的 s1
    expect(pl.layout.focusedGroupId).toBe(groups()[0].id);
    expect(pl.activeSessionId.value).toBe("s1");
    expect(groups().flatMap((g) => g.tabs).filter((t) => t.sessionId === "s1")).toHaveLength(1);
  });

  it("openSessionInNewTab：未启动会话也开固定 tab，不占预览位；已打开则只聚焦", () => {
    const pl = usePaneLayout();
    pl.openSession("preview");
    pl.openSessionInNewTab("s1"); // s1 未启动，但显式动作 → 固定 tab
    expect(focused().tabs).toHaveLength(2);
    const t = focused().tabs.find((x) => x.sessionId === "s1")!;
    expect(focused().previewTabId).not.toBe(t.id);
    pl.openSessionInNewTab("s1");
    expect(focused().tabs).toHaveLength(2); // 全局唯一
  });

  it("openSessionInSplit 对已打开会话也只聚焦，不再拆分", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    pl.openSessionInSplit("s1", "vertical");
    expect(groups()).toHaveLength(1);
  });
});

describe("拆分与关闭", () => {
  it("splitFocusedGroup：多 tab 时激活 tab 移入新组并聚焦新组", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    started.add("s1");
    pl.promoteTab("s1");
    pl.openSession("s2");
    started.add("s2");
    pl.promoteTab("s2");
    pl.splitFocusedGroup("horizontal");
    expect(groups()).toHaveLength(2);
    expect(groups()[0].tabs.map((t) => t.sessionId)).toEqual(["s1"]);
    expect(groups()[1].tabs.map((t) => t.sessionId)).toEqual(["s2"]);
    expect(pl.activeSessionId.value).toBe("s2");
  });

  it("关掉组内最后一个 tab：组消失、split 拍平、聚焦修复", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    started.add("s1");
    pl.promoteTab("s1");
    pl.openSessionInSplit("s2", "horizontal");
    const right = groups()[1];
    pl.closeTab(right.id, right.tabs[0].id);
    expect(groups()).toHaveLength(1);
    expect(pl.layout.focusedGroupId).toBe(groups()[0].id);
    expect(pl.activeSessionId.value).toBe("s1");
  });

  it("关掉最后一个 tab：回到空根组（零会话欢迎态）", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    const g = focused();
    pl.closeTab(g.id, g.tabs[0].id);
    expect(groups()).toHaveLength(1);
    expect(focused().tabs).toHaveLength(0);
    expect(pl.activeSessionId.value).toBe("");
  });

  it("空根组（欢迎态）上 openSession / openBlankTab 正常建 tab", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    expect(focused().tabs).toHaveLength(1);
    expect(pl.activeSessionId.value).toBe("s1");
    // 关回空根组后 openBlankTab 也能建
    pl.closeTab(focused().id, focused().tabs[0].id);
    expect(focused().tabs).toHaveLength(0);
    pl.openBlankTab("新会话 A");
    expect(focused().tabs).toHaveLength(1);
    expect(focused().tabs[0].sessionId).toBeNull();
    expect(focused().tabs[0].pendingName).toBe("新会话 A");
  });

  it("空根组（欢迎态）上 splitFocusedGroup 是 no-op", () => {
    const pl = usePaneLayout();
    pl.splitFocusedGroup("horizontal");
    expect(groups()).toHaveLength(1);
    expect(focused().tabs).toHaveLength(0);
  });

  it("空根组（欢迎态）上 openSessionInSplit 退化为直接开进空组", () => {
    const pl = usePaneLayout();
    pl.openSessionInSplit("s1", "horizontal");
    expect(groups()).toHaveLength(1);
    expect(focused().tabs.map((t) => t.sessionId)).toEqual(["s1"]);
    expect(pl.activeSessionId.value).toBe("s1");
  });

  it("hasAnyTab：空根组为 false，有 tab 为 true，关光回到 false", () => {
    const pl = usePaneLayout();
    expect(pl.hasAnyTab.value).toBe(false);
    pl.openSession("s1");
    expect(pl.hasAnyTab.value).toBe(true);
    pl.closeTab(focused().id, focused().tabs[0].id);
    expect(pl.hasAnyTab.value).toBe(false);
  });

  it("closeOtherTabs 只留目标 tab 且激活它", () => {
    const pl = usePaneLayout();
    ["a", "b", "c"].forEach((s) => {
      pl.openSession(s);
      started.add(s);
      pl.promoteTab(s);
    });
    const g = focused();
    const keep = g.tabs.find((t) => t.sessionId === "b")!;
    pl.closeOtherTabs(g.id, keep.id);
    expect(g.tabs.map((t) => t.sessionId)).toEqual(["b"]);
    expect(g.activeTabId).toBe(keep.id);
  });

  it("closeSessionTab：会话删除时对应 tab 消失", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    started.add("s1");
    pl.promoteTab("s1");
    pl.openSession("s2");
    pl.closeSessionTab("s1");
    expect(groups().flatMap((g) => g.tabs).some((t) => t.sessionId === "s1")).toBe(false);
  });
});

describe("会话 id 生命周期接线", () => {
  it("bindSession + rebindSession + takePendingName 完整走一遍", () => {
    const pl = usePaneLayout();
    pl.openBlankTab("我的新会话");
    const tab = focused().tabs[0];
    pl.bindSession(tab.id, "temp-id");
    expect(pl.activeSessionId.value).toBe("temp-id");
    pl.promoteTab("temp-id"); // 派发即启动 → 转正
    expect(focused().previewTabId).toBeNull();
    pl.rebindSession("temp-id", "real-id");
    expect(pl.activeSessionId.value).toBe("real-id");
    expect(pl.takePendingName("real-id")).toBe("我的新会话");
    expect(pl.takePendingName("real-id")).toBe(""); // 一次性
  });
});

describe("空白 tab 工作区归属快照（创建时绑定）", () => {
  const wsA = { wsKey: "key-a", wsPath: "C:\\proj\\a" };
  const wsB = { wsKey: "key-b", wsPath: "C:\\proj\\b" };

  it("openBlankTab 带 pendingWs 落到 tab 上", () => {
    const pl = usePaneLayout();
    pl.openBlankTab("新会话 A", wsA);
    expect(focused().tabs[0].pendingWs).toEqual(wsA);
  });

  it("复用预览 tab：有新快照换绑，无快照清除旧绑定", () => {
    const pl = usePaneLayout();
    pl.openSession("s1"); // s1 未启动 → 预览 tab
    pl.openBlankTab("新会话 A", wsA); // 复用预览 tab
    expect(focused().tabs).toHaveLength(1);
    expect(focused().tabs[0].pendingWs).toEqual(wsA);
    pl.openBlankTab("新会话 B", wsB); // 换绑
    expect(focused().tabs[0].pendingWs).toEqual(wsB);
    pl.openBlankTab("新会话 C"); // 无新快照 → 清除旧绑定
    expect(focused().tabs[0].pendingWs).toBeUndefined();
  });

  it("openSession 复用预览 tab 后 pendingWs 被清（改绑已存在会话，归属走注册表）", () => {
    const pl = usePaneLayout();
    pl.openBlankTab("新会话 A", wsA);
    pl.openSession("s1"); // s1 未启动 → 复用这个预览 tab
    expect(focused().tabs).toHaveLength(1);
    expect(focused().tabs[0].sessionId).toBe("s1");
    expect(focused().tabs[0].pendingWs).toBeUndefined();
  });

  it("bindSession 后 pendingWs 被清（归属已种进注册表）", () => {
    const pl = usePaneLayout();
    pl.openBlankTab("新会话 A", wsA);
    const tab = focused().tabs[0];
    pl.bindSession(tab.id, "temp-id");
    expect(tab.sessionId).toBe("temp-id");
    expect(tab.pendingWs).toBeUndefined();
  });
});

describe("tab 切换与聚焦", () => {
  it("MRU 切换：快速按一次在最近两个会话间往返（OS Alt+Tab 语义）", () => {
    const pl = usePaneLayout();
    ["a", "b", "c"].forEach((s) => {
      pl.openSession(s);
      started.add(s);
      pl.promoteTab(s);
    }); // 激活顺序 a→b→c，MRU: c,b,a
    expect(pl.activeSessionId.value).toBe("c");
    pl.mruSwitch(1);
    pl.endMruSwitch();
    expect(pl.activeSessionId.value).toBe("b"); // 回到最近用过的
    pl.mruSwitch(1);
    pl.endMruSwitch();
    expect(pl.activeSessionId.value).toBe("c"); // 再按一次弹回来（往返）
  });

  it("MRU 切换：按住不放连按沿最近使用列表回溯，松开才提交栈序", () => {
    const pl = usePaneLayout();
    ["a", "b", "c"].forEach((s) => {
      pl.openSession(s);
      started.add(s);
      pl.promoteTab(s);
    }); // MRU: c,b,a
    pl.mruSwitch(1); // → b（回溯中，栈序冻结）
    pl.mruSwitch(1); // → a
    expect(pl.activeSessionId.value).toBe("a");
    pl.mruSwitch(-1); // Shift 反向 → b
    expect(pl.activeSessionId.value).toBe("b");
    pl.endMruSwitch(); // 提交：MRU 变为 b,c,a
    pl.mruSwitch(1);
    pl.endMruSwitch();
    expect(pl.activeSessionId.value).toBe("c");
  });

  it("MRU 切换跨分屏组，且已关闭的 tab 被惰性跳过", () => {
    const pl = usePaneLayout();
    pl.openSession("a");
    started.add("a");
    pl.promoteTab("a");
    pl.openSessionInSplit("b", "horizontal"); // b 在右组，MRU: b,a
    pl.openSession("c"); // 落在聚焦的右组
    started.add("c");
    pl.promoteTab("c"); // MRU: c,b,a
    pl.closeSessionTab("b");
    pl.mruSwitch(1);
    pl.endMruSwitch();
    expect(pl.activeSessionId.value).toBe("a"); // b 已关，跳到 a（在另一组，聚焦跟随）
    expect(groups().find((g) => g.id === pl.layout.focusedGroupId)!.tabs.some((t) => t.sessionId === "a")).toBe(true);
  });

  it("只有一个 tab 时 MRU 切换是 no-op", () => {
    const pl = usePaneLayout();
    pl.openSession("a");
    pl.mruSwitch(1);
    pl.endMruSwitch();
    expect(pl.activeSessionId.value).toBe("a");
  });

  it("setActiveTab 同时聚焦该组", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    started.add("s1");
    pl.promoteTab("s1");
    pl.openSessionInSplit("s2", "horizontal");
    const left = groups()[0];
    pl.setActiveTab(left.id, left.tabs[0].id);
    expect(pl.layout.focusedGroupId).toBe(left.id);
    expect(pl.activeSessionId.value).toBe("s1");
  });
});

describe("serialize / restore", () => {
  it("往返恢复布局；空白布局 serialize 为 null", () => {
    const pl = usePaneLayout();
    expect(pl.serialize()).toBeNull();
    pl.openSession("s1");
    started.add("s1");
    pl.promoteTab("s1");
    pl.openSessionInSplit("s2", "vertical");
    const snap = pl.serialize()!;
    pl.reset();
    expect(groups()).toHaveLength(1);
    expect(pl.restore(snap, new Set(["s1", "s2"]))).toBe(true);
    expect(groups()).toHaveLength(2);
    expect((pl.layout.root as SplitNode).direction).toBe("vertical");
    expect(pl.activeSessionId.value).toBe("s2"); // 聚焦组恢复
  });

  it("serialize 携带注册表里的名字与工作区归属（快照 v2）", () => {
    const pl = usePaneLayout();
    useSessionNames().setName("sx", "会话X");
    useSessionWorkspaces().setWorkspace("sx", { wsKey: "C--proj-x", wsPath: "C:\\proj\\x" });
    pl.openSession("sx");
    const snap = pl.serialize()!;
    expect(listSnapshotTabs(snap)).toEqual([
      { sessionId: "sx", name: "会话X", wsKey: "C--proj-x", wsPath: "C:\\proj\\x" },
    ]);
  });

  it("restore 全部失效 → 回退空白并返回 false", () => {
    const pl = usePaneLayout();
    pl.openSession("s1");
    const snap = pl.serialize()!;
    expect(pl.restore(snap, new Set())).toBe(false);
    expect(groups()).toHaveLength(1);
    expect(pl.activeSessionId.value).toBe("");
  });
});
