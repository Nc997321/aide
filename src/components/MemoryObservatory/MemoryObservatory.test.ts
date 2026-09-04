// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import type { MemoryEvent, MemoryScanResult, MemoryTopic } from "@aide/sdk/api";

// ── 纯函数层 ──
import {
  statusOf,
  growthCurve,
  recentChanges,
  daysSinceLatest,
  indexUsage,
  fmtSize,
  usageByMemory,
  topUsed,
  weeklyCounts,
  dailyCounts,
  recentActivity,
  sessionMemoryIds,
  sessionsOfMemory,
  reachLevels,
} from "./observatory";

function topic(p: Partial<MemoryTopic> & { name: string }): MemoryTopic {
  return {
    size: 100,
    createdMs: null,
    modifiedMs: null,
    indexed: true,
    withinWindow: true,
    sourceDir: "/x",
    ...p,
  };
}

const DAY = 86400_000;

describe("observatory 纯函数", () => {
  it("statusOf 三态", () => {
    expect(statusOf(topic({ name: "a", indexed: true, withinWindow: true }))).toBe("indexed");
    expect(statusOf(topic({ name: "a", indexed: true, withinWindow: false }))).toBe("edge");
    expect(statusOf(topic({ name: "a", indexed: false, withinWindow: false }))).toBe("orphan");
  });

  it("growthCurve 按创建日累积，缺失 created 退 modified", () => {
    const t0 = Date.UTC(2026, 8, 1);
    const pts = growthCurve([
      topic({ name: "a", createdMs: t0 }),
      topic({ name: "b", createdMs: t0 }),
      topic({ name: "c", createdMs: t0 + 2 * DAY }),
      topic({ name: "d", createdMs: null, modifiedMs: t0 + DAY }),
    ]);
    expect(pts).toHaveLength(3);
    expect(pts[2].count).toBe(4);
    expect(pts[0].count).toBe(2);
  });

  it("recentChanges 区分新增与修订，7 天窗口", () => {
    const now = Date.UTC(2026, 8, 4);
    const items = recentChanges(
      [
        topic({ name: "new.md", createdMs: now - DAY, modifiedMs: now - DAY }),
        topic({ name: "mod.md", createdMs: now - 30 * DAY, modifiedMs: now - DAY }),
        topic({ name: "old.md", createdMs: now - 30 * DAY, modifiedMs: now - 30 * DAY }),
      ],
      7,
      now,
    );
    expect(items.map((i) => `${i.op}:${i.name}`)).toEqual(["created:new.md", "modified:mod.md"]);
  });

  it("daysSinceLatest / indexUsage", () => {
    const now = Date.UTC(2026, 8, 4);
    expect(daysSinceLatest([topic({ name: "a", createdMs: now - 2 * DAY })], now)).toBe(2);
    expect(daysSinceLatest([], now)).toBeNull();
    const scan = {
      index: { lines: 100, bytes: 12800, entries: [] },
      limits: { maxLines: 200, maxBytes: 25600 },
    } as MemoryScanResult;
    const u = indexUsage(scan);
    expect(u.pct).toBe(0.5);
  });

  it("fmtSize", () => {
    expect(fmtSize(512)).toBe("512B");
    expect(fmtSize(9424)).toBe("9.2K");
  });

  // ── 事件台账聚合 ──
  const T0 = Date.UTC(2026, 8, 4, 10); // 周五
  function ev(p: Partial<MemoryEvent> & { op: string; memoryId: string }): MemoryEvent {
    return { ts: T0, sessionId: "s1", workspaceKey: "C--x", ...p };
  }

  it("usageByMemory / topUsed：read 计数 + 最近时间，TOP N 排序", () => {
    const events = [
      ev({ op: "read", memoryId: "a.md", ts: T0 - 1000 }),
      ev({ op: "read", memoryId: "a.md", ts: T0 }),
      ev({ op: "read", memoryId: "b.md", ts: T0 - 500 }),
      ev({ op: "created", memoryId: "c.md" }), // 非 read 不计入
    ];
    const u = usageByMemory(events);
    expect(u.get("a.md")).toEqual({ reads: 2, lastTs: T0 });
    expect(u.has("c.md")).toBe(false);
    const top = topUsed(events, 5);
    expect(top.map((t) => t.memoryId)).toEqual(["a.md", "b.md"]);
  });

  it("weeklyCounts：周一起算，本周新增/使用", () => {
    const monday = Date.UTC(2026, 7, 31, 9); // 本周一
    const lastWeek = Date.UTC(2026, 7, 29, 9); // 上周六
    const w = weeklyCounts(
      [
        ev({ op: "created", memoryId: "a.md", ts: monday }),
        ev({ op: "read", memoryId: "a.md", ts: T0 }),
        ev({ op: "read", memoryId: "b.md", ts: T0 }),
        ev({ op: "created", memoryId: "old.md", ts: lastWeek }),
        ev({ op: "read", memoryId: "old.md", ts: lastWeek }),
      ],
      T0,
    );
    expect(w).toEqual({ created: 1, used: 2 });
  });

  it("dailyCounts / recentActivity", () => {
    const events = [
      ev({ op: "read", memoryId: "a.md", ts: T0 }),
      ev({ op: "created", memoryId: "b.md", ts: T0 - DAY }),
      ev({ op: "updated", memoryId: "b.md", ts: T0 }),
    ];
    expect(dailyCounts(events, ["read"]).reduce((n, d) => n + d.count, 0)).toBe(1);
    expect(dailyCounts(events, ["created", "updated"]).reduce((n, d) => n + d.count, 0)).toBe(2);
    const act = recentActivity(events, 10);
    expect(act[0].ts).toBe(T0); // 倒序
  });

  it("sessionMemoryIds / sessionsOfMemory 双向查询", () => {
    const events = [
      ev({ op: "read", memoryId: "a.md", sessionId: "s1" }),
      ev({ op: "created", memoryId: "b.md", sessionId: "s1" }),
      ev({ op: "read", memoryId: "a.md", sessionId: "s2" }),
      ev({ op: "read", memoryId: "c.md", sessionId: "s2" }),
    ];
    expect([...sessionMemoryIds(events, "s1")].sort()).toEqual(["a.md", "b.md"]);
    expect([...sessionsOfMemory(events, "a.md")].sort()).toEqual(["s1", "s2"]);
    expect(sessionsOfMemory(events, "b.md").size).toBe(0); // created 不算「使用」
  });

  it("reachLevels 四级分桶 + L0 含 CLAUDE.md", () => {
    const scan = scanFixture();
    const r = reachLevels(scan);
    expect(r.l1.map((t) => t.name)).toEqual(["a.md"]);
    expect(r.l3.map((t) => t.name)).toEqual(["b.md"]);
    expect(r.l0).toBe(2 + 1); // 两条窗口内索引 + CLAUDE.md
  });

  it("口径：MEMORY.md 索引不计入使用统计，但保留在活动 feed", () => {
    const events = [
      ev({ op: "read", memoryId: "MEMORY.md", ts: T0 }),
      ev({ op: "updated", memoryId: "MEMORY.md", ts: T0 }),
      ev({ op: "read", memoryId: "a.md", ts: T0 }),
    ];
    expect(usageByMemory(events).has("MEMORY.md")).toBe(false);
    expect(usageByMemory(events).get("a.md")?.reads).toBe(1);
    expect(weeklyCounts(events, T0)).toEqual({ created: 0, used: 1 });
    expect(dailyCounts(events, ["read"]).reduce((n, d) => n + d.count, 0)).toBe(1);
    expect([...sessionMemoryIds(events, "s1")]).toEqual(["a.md"]);
    expect(recentActivity(events, 10)).toHaveLength(3); // feed 全量保留
  });
});

// ── 组件：删除确认流 + 状态联动 ──
const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  snapshot: vi.fn(),
  readFile: vi.fn(async () => "# 内容"),
  deleteFile: vi.fn(async () => ({ deleted: true, indexLineRemoved: true })),
  events: vi.fn(async () => ({ events: [], sessionNames: {} })),
}));

vi.mock("@aide/sdk/api", () => ({
  memoryObservatoryApi: mocks,
  CLAUDE_MD_ALIAS: "__claude_md__",
}));

vi.mock("@/components/Icon.vue", () => ({
  default: { template: "<span />" },
}));

import MemoryObservatory from "./MemoryObservatory.vue";

function scanFixture(): MemoryScanResult {
  return {
    index: {
      lines: 3,
      bytes: 120,
      entries: [
        { title: "甲", file: "a.md", desc: "描述甲", line: 1, byteOffset: 0 },
        { title: "乙", file: "gone.md", desc: "死链", line: 2, byteOffset: 60 },
      ],
    },
    topics: [
      topic({ name: "a.md", modifiedMs: Date.UTC(2026, 8, 2) }),
      topic({ name: "b.md", indexed: false, withinWindow: false, modifiedMs: Date.UTC(2026, 8, 1) }),
    ],
    orphans: ["b.md"],
    deadlinks: ["gone.md"],
    claudeMd: { path: "/home/.aide/claude/CLAUDE.md", bytes: 1900, modifiedMs: Date.UTC(2026, 7, 30) },
    limits: { maxLines: 200, maxBytes: 25600 },
  };
}

async function mountPanel() {
  mocks.scan.mockResolvedValue(scanFixture());
  mocks.snapshot.mockResolvedValue({ previousTs: null, added: [], removed: [], modified: [] });
  const wrapper = mount(MemoryObservatory, {
    props: { workspaceKey: "C--x", workspaceName: "x" },
    global: { directives: { tooltip: () => {} }, stubs: { Teleport: true } },
  });
  await vi.waitFor(() => expect(wrapper.text()).toContain("甲"));
  return wrapper;
}

describe("MemoryObservatory 面板", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.mockResolvedValue({ events: [], sessionNames: {} });
  });

  it("加载后展示 stat / 清单 / 告警计数", async () => {
    const w = await mountPanel();
    expect(mocks.scan).toHaveBeenCalledWith("C--x");
    expect(w.text()).toContain("记忆观测台");
    expect(w.text()).toContain("孤儿 · 索引未引用 1");
    expect(w.text()).toContain("死链 · 文件不存在 1");
    expect(w.text()).toContain("CLAUDE.md");
  });

  it("删除确认流：确认→调命令→行移除；取消→状态复位", async () => {
    const w = await mountPanel();
    const row = w.findAll(".row").find((r) => r.text().includes("甲"))!;
    await row.find(".del").trigger("click");
    expect(w.text()).toContain("删除「甲」？");

    // 取消路径
    await w.find(".row-confirm .btn:not(.danger)").trigger("click");
    expect(w.text()).not.toContain("删除「甲」？");

    // 确认路径（取消后重渲染，重新取行）
    const row2 = w.findAll(".row").find((r) => r.text().includes("甲"))!;
    await row2.find(".del").trigger("click");
    await w.find(".row-confirm .btn.danger").trigger("click");
    await vi.waitFor(() => expect(w.text()).not.toContain("描述甲"));
    expect(mocks.deleteFile).toHaveBeenCalledWith("C--x", "a.md");
  });

  it("Esc 关闭", async () => {
    const w = await mountPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(w.emitted("close")).toBeTruthy();
  });

  it("影响 tab：可达性分级 + 使用统计 + 本次任务 chip", async () => {
    const now = Date.now();
    mocks.events.mockResolvedValue({
      events: [
        { ts: now - 1000, sessionId: "s1", workspaceKey: "C--x", op: "read", memoryId: "a.md" },
        { ts: now - 500, sessionId: "s1", workspaceKey: "C--x", op: "read", memoryId: "a.md" },
        { ts: now - 300, sessionId: "s2", workspaceKey: "C--x", op: "created", memoryId: "b.md" },
      ],
      sessionNames: { s1: "修复登录态", s2: "重构侧栏" },
    });
    mocks.scan.mockResolvedValue(scanFixture());
    mocks.snapshot.mockResolvedValue({ previousTs: null, added: [], removed: [], modified: [] });
    const w = await mount(MemoryObservatory, {
      props: { workspaceKey: "C--x", workspaceName: "x", currentSessionId: "s1" },
      global: { directives: { tooltip: () => {} }, stubs: { Teleport: true } },
    });
    await vi.waitFor(() => expect(w.text()).toContain("甲"));

    await w.findAll(".mo-tab").find((t) => t.text().includes("影响"))!.trigger("click");
    expect(w.text()).toContain("本次任务使用了 1 条记忆");
    expect(w.text()).toContain("L3 · 沉没");
    expect(w.text()).toContain("最常用 · TOP 5");
    expect(w.text()).toContain("修复登录态"); // 最近活动里的会话名
  });

  it("删除后本地台账补一条 deleted 事件", async () => {
    const w = await mountPanel();
    const row = w.findAll(".row").find((r) => r.text().includes("甲"))!;
    await row.find(".del").trigger("click");
    await w.find(".row-confirm .btn.danger").trigger("click");
    await vi.waitFor(() => expect(w.text()).not.toContain("描述甲"));
    await w.findAll(".mo-tab").find((t) => t.text().includes("影响"))!.trigger("click");
    expect(w.text()).toContain("最近活动");
  });
});
