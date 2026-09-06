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
  sumReachLevels,
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

  it("sumReachLevels：跨项目汇总，CLAUDE.md 只算一次", () => {
    const mk = (windowEntries: number, topics: MemoryTopic[]): MemoryScanResult => ({
      index: {
        lines: windowEntries,
        bytes: 100,
        entries: Array.from({ length: windowEntries }, (_, i) => ({
          title: `t${i}`,
          file: `t${i}.md`,
          desc: "",
          line: i + 1,
          byteOffset: 0,
        })),
      },
      topics,
      orphans: [],
      deadlinks: [],
      claudeMd: null, // per-project scan 不含全局指令
      limits: { maxLines: 200, maxBytes: 25600 },
    });
    const r = sumReachLevels(
      [
        mk(2, [topic({ name: "a.md" }), topic({ name: "o.md", indexed: false, withinWindow: false })]),
        mk(3, [topic({ name: "b.md", withinWindow: false })]),
      ],
      true,
    );
    expect(r.l0).toBe(2 + 3 + 1); // 窗口条目之和 + CLAUDE.md 一次
    expect(r.l1).toHaveLength(1);
    expect(r.l2).toHaveLength(1);
    expect(r.l3).toHaveLength(1);
  });
});

// ── 组件：删除确认流 + 状态联动 ──
const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  snapshot: vi.fn(),
  readFile: vi.fn(async () => "# 内容"),
  deleteFile: vi.fn(async () => ({ deleted: true, indexLineRemoved: true })),
  events: vi.fn(async () => ({ events: [], sessionNames: {} })),
  scanAll: vi.fn(async () => ({ projects: [], claudeMd: null })),
  // FileViewer 单例的 open()；2026-09-06 起记忆行点击走这条路径，与文件树点 markdown 同范式
  fileViewerOpen: vi.fn(async () => undefined),
}));

vi.mock("@aide/sdk/api", () => ({
  memoryObservatoryApi: mocks,
  CLAUDE_MD_ALIAS: "__claude_md__",
}));

vi.mock("@/components/Icon.vue", () => ({
  default: { template: "<span />" },
}));

vi.mock("@/composables/useFileViewer", () => ({
  useFileViewer: () => ({ open: mocks.fileViewerOpen }),
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
    mocks.scanAll.mockResolvedValue({ projects: [], claudeMd: null });
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

  // 主区视图（非模态）：不再接 Esc / 点外部关闭，关闭入口只剩头部 ✕
  // （另有侧栏底部入口再点一次、选中会话两条路径，都在 App.vue）
  it("头部 ✕ 关闭", async () => {
    const w = await mountPanel();
    await w.find(".mo-close").trigger("click");
    expect(w.emitted("close")).toBeTruthy();
  });

  // 行点击 → FileViewer.open(path)：与文件树点 markdown 文件同范式，marked 渲染
  // + 可编辑保存。死链（无 path）不触发；CLAUDE.md 走 claudeMd.path。
  it("记忆行点击调 FileViewer.open(path)", async () => {
    mocks.scan.mockResolvedValueOnce({
      ...scanFixture(),
      topics: [
        topic({ name: "a.md", path: "/proj/memory/a.md", modifiedMs: Date.UTC(2026, 8, 2) }),
        topic({ name: "b.md", path: "/proj/memory/b.md", indexed: false, withinWindow: false, modifiedMs: Date.UTC(2026, 8, 1) }),
      ],
      deadlinks: [],
    });
    mocks.snapshot.mockResolvedValueOnce({ previousTs: null, added: [], removed: [], modified: [] });
    const w = await mount(MemoryObservatory, {
      props: { workspaceKey: "C--x", workspaceName: "x" },
      global: { directives: { tooltip: () => {} }, stubs: { Teleport: true } },
    });
    await vi.waitFor(() => expect(w.text()).toContain("甲"));
    mocks.fileViewerOpen.mockClear();

    const liveRow = w.findAll(".row").find((r) => r.text().includes("甲"))!;
    await liveRow.find(".row-main").trigger("click");
    expect(mocks.fileViewerOpen).toHaveBeenCalledTimes(1);
    expect(mocks.fileViewerOpen).toHaveBeenCalledWith("/proj/memory/a.md");
  });

  it("死链行点击不调 FileViewer.open（无文件可开）", async () => {
    const w = await mountPanel();
    await w.findAll(".chip").find((c) => c.text().includes("死链"))!.trigger("click");
    // 死链行不显示文件名（fixture.title="死链"），只露"索引引用的文件已不存在"这条 desc
    await vi.waitFor(() => expect(w.text()).toContain("索引引用的文件已不存在"));
    mocks.fileViewerOpen.mockClear();
    const deadRow = w.findAll(".row").find((r) => r.text().includes("索引引用的文件已不存在"))!;
    await deadRow.find(".row-main").trigger("click");
    expect(mocks.fileViewerOpen).not.toHaveBeenCalled();
  });

  it("CLAUDE.md 行点击调 FileViewer.open(claudeMd.path)", async () => {
    const w = await mountPanel();
    mocks.fileViewerOpen.mockClear();
    const claudeRow = w.findAll(".row").find((r) => r.text().includes("CLAUDE.md"))!;
    await claudeRow.find(".row-main").trigger("click");
    expect(mocks.fileViewerOpen).toHaveBeenCalledWith("/home/.aide/claude/CLAUDE.md");
  });

  it("头部 ⤴ 刷新按钮重调 scan", async () => {
    const w = await mountPanel();
    mocks.scan.mockClear();
    await w.find(".mo-refresh").trigger("click");
    expect(mocks.scan).toHaveBeenCalledWith("C--x");
  });

  it("不接 Esc（主区视图无模态语义）", async () => {
    const w = await mountPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(w.emitted("close")).toBeFalsy();
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

  it("全部项目 scope：分组渲染 + 搜索过滤 + 影响 tab 用汇总可达性", async () => {
    mocks.scanAll.mockResolvedValue({
      projects: [
        {
          key: "C--proj-a",
          scan: {
            index: { lines: 1, bytes: 40, entries: [{ title: "甲A", file: "a.md", desc: "项目A的记忆", line: 1, byteOffset: 0 }] },
            topics: [topic({ name: "a.md", modifiedMs: Date.now() })],
            orphans: [],
            deadlinks: [],
            claudeMd: null,
            limits: { maxLines: 200, maxBytes: 25600 },
          },
        },
        {
          key: "C--proj-b",
          scan: {
            index: null,
            topics: [topic({ name: "b.md", indexed: false, withinWindow: false, modifiedMs: Date.now() })],
            orphans: ["b.md"],
            deadlinks: [],
            claudeMd: null,
            limits: { maxLines: 200, maxBytes: 25600 },
          },
        },
      ],
      claudeMd: { path: "/x/CLAUDE.md", bytes: 100, modifiedMs: null },
    });
    const w = await mountPanel();
    await w.findAll(".mo-scope button").find((b) => b.text() === "全部项目")!.trigger("click");
    await vi.waitFor(() => expect(w.text()).toContain("甲A"));

    expect(mocks.scanAll).toHaveBeenCalled();
    expect(mocks.events).toHaveBeenLastCalledWith(null); // 全局 = 不过滤
    expect(w.text()).toContain("C--proj-a"); // 未登记工作区回落 key
    expect(w.text()).toContain("1 孤儿"); // 分组健康计数

    // 搜索过滤：只留命中项目
    await w.find(".search input").setValue("项目A");
    expect(w.text()).toContain("甲A");
    expect(w.findAll(".group")).toHaveLength(1);

    // 影响 tab：reachOverride 生效（L3 计入 proj-b 的孤儿）
    await w.find(".search input").setValue("");
    await w.findAll(".mo-tab").find((t) => t.text().includes("影响"))!.trigger("click");
    expect(w.text()).toContain("L3 · 沉没");
    const l3row = w.findAll(".reach-row").find((r) => r.text().includes("L3"))!;
    expect(l3row.find(".lv-n").text()).toBe("1");
  });
});
