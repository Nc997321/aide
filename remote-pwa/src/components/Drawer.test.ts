import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { Session, WorkspaceInfo } from "@aide/sdk/types";
import Drawer from "./Drawer.vue";

/**
 * Drawer（Kimi 式抽屉）测试：开合、会话列表（过滤/高亮/live 徽标）、
 * 工作区弹层、供应商徽标/断开/刷新入口、重开清搜索。
 */

function makeSession(over: Partial<Session> & { id: string }): Session {
  return { name: "会话", timestamp: Date.now() - 60_000, ...over } as Session;
}

function mountDrawer(over?: {
  open?: boolean;
  sessions?: Session[];
  liveSessions?: Set<string>;
  workspaces?: WorkspaceInfo[];
  activeWorkspaceKey?: string | null;
  currentSessionId?: string | null;
}) {
  return mount(Drawer, {
    props: {
      open: over?.open ?? true,
      connState: "authed" as const,
      sessions: over?.sessions ?? [],
      liveSessions: over?.liveSessions ?? new Set<string>(),
      refreshing: false,
      workspaces: over?.workspaces ?? [],
      activeWorkspaceKey: over?.activeWorkspaceKey ?? null,
      currentSessionId: over?.currentSessionId ?? null,
      provider: { kind: "zhipu", icon: "Z", name: "智谱" },
    },
  });
}

describe("Drawer（左侧抽屉）", () => {
  it("open 控制 show 类；mask 点击 → emit close", async () => {
    const w = mountDrawer({ open: false });
    expect(w.find(".dr-mask").classes()).not.toContain("show");
    await w.find(".dr-mask").trigger("click"); // 遮罩自身（.self）点击
    expect(w.emitted("close")).toBeTruthy();
  });

  it("设备卡：状态文案 + 供应商徽标（品牌 svg + 名）；点徽标 → emit openProviders", async () => {
    const w = mountDrawer();
    expect(w.text()).toContain("桌面 aide");
    expect(w.text()).toContain("已连接");
    expect(w.find(".dr-badge-name").text()).toBe("智谱");
    // kind=zhipu 命中 SDK 商标库 → 品牌色 path 渲染（与桌面同库）
    expect(w.find(".dr-badge svg.pl-svg").exists()).toBe(true);
    expect(w.find(".dr-badge svg.pl-svg path").attributes("fill")).toBe("#3859FF");
    await w.find(".dr-badge").trigger("click");
    expect(w.emitted("openProviders")).toBeTruthy();
  });

  it("断开按钮 → emit quit", async () => {
    const w = mountDrawer();
    await w.find(".dr-head .icon-btn").trigger("click");
    expect(w.emitted("quit")).toBeTruthy();
  });

  it("会话列表：渲染 + 当前会话高亮 + 点击 emit openSession", async () => {
    const s1 = makeSession({ id: "s1", name: "重构 LSP" });
    const s2 = makeSession({ id: "s2", name: "修 bug" });
    const w = mountDrawer({ sessions: [s1, s2], currentSessionId: "s1" });
    const items = w.findAll(".sv-item");
    expect(items.length).toBe(2);
    expect(items[0].classes()).toContain("on");
    expect(items[1].classes()).not.toContain("on");
    await items[1].trigger("click");
    expect(w.emitted("openSession")![0]).toEqual([s2]);
  });

  it("搜索过滤：关键词大小写不敏感匹配会话名", async () => {
    const w = mountDrawer({
      sessions: [
        makeSession({ id: "s1", name: "重构 LSP" }),
        makeSession({ id: "s2", name: "修 Bug" }),
      ],
    });
    expect(w.findAll(".sv-item").length).toBe(2);
    await w.find(".dr-search input").setValue("bug");
    expect(w.findAll(".sv-item").length).toBe(1);
    expect(w.findAll(".sv-item")[0].text()).toContain("修 Bug");
    // 无匹配提示
    await w.find(".dr-search input").setValue("zzz");
    expect(w.find(".dr-none").exists()).toBe(true);
    expect(w.text()).toContain("无匹配会话");
  });

  it("liveSessions：对应会话显示「回复中」徽标", () => {
    const w = mountDrawer({
      sessions: [makeSession({ id: "s1" })],
      liveSessions: new Set(["s1"]),
    });
    expect(w.find(".sv-live").exists()).toBe(true);
    expect(w.text()).toContain("回复中");
  });

  it("空列表：引导文案指向右上 ＋", () => {
    const w = mountDrawer();
    expect(w.text()).toContain("暂无会话");
  });

  it("工作区 chip：跟随桌面文案 / 点击开弹层 / 选择 → emit workspaceChange", async () => {
    const ws: WorkspaceInfo[] = [
      { key: "k1", name: "C:/proj/aide", missing: false },
      { key: "k2", name: "C:/proj/other", missing: false },
    ];
    const w = mountDrawer({ workspaces: ws, activeWorkspaceKey: null });
    // 跟随桌面（null）
    expect(w.find(".ws-chip .ws-name").text()).toContain("跟随桌面当前工作区");

    await w.find(".ws-chip").trigger("click");
    expect(w.find(".ws-mask").classes()).toContain("show");
    const opts = w.findAll(".ws-opt");
    expect(opts.length).toBe(2);

    // 选 k1 → emit（值变化）
    await opts[0].trigger("click");
    expect(w.emitted("workspaceChange")![0]).toEqual(["k1"]);
    // 弹层收回
    expect(w.find(".ws-mask").classes()).not.toContain("show");
  });

  it("工作区固定选择后：chip 显示所选名 + 弹层勾选态", async () => {
    const ws: WorkspaceInfo[] = [
      { key: "k1", name: "C:/proj/aide", missing: false },
      { key: "k2", name: "C:/proj/other", missing: false },
    ];
    const w = mountDrawer({ workspaces: ws, activeWorkspaceKey: "k2" });
    expect(w.find(".ws-chip .ws-name").text()).toBe("C:/proj/other");
    await w.find(".ws-chip").trigger("click");
    const opts = w.findAll(".ws-opt");
    expect(opts[1].classes()).toContain("on");
    // 同值再点：不 emit
    await opts[1].trigger("click");
    expect(w.emitted("workspaceChange")).toBeFalsy();
  });

  it("刷新按钮 → emit refresh", async () => {
    const w = mountDrawer();
    await w.find(".dr-sec .icon-btn").trigger("click");
    expect(w.emitted("refresh")).toBeTruthy();
  });

  it("重开抽屉清搜索词（上次过滤不跨次残留）", async () => {
    const w = mountDrawer({
      sessions: [
        makeSession({ id: "s1", name: "重构 LSP" }),
        makeSession({ id: "s2", name: "修 Bug" }),
      ],
    });
    await w.find(".dr-search input").setValue("bug");
    expect(w.findAll(".sv-item").length).toBe(1);
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    expect((w.find(".dr-search input").element as HTMLInputElement).value).toBe("");
    expect(w.findAll(".sv-item").length).toBe(2);
  });

  it("offline 状态：设备卡显示「设备离线」", async () => {
    const w = mountDrawer();
    await w.setProps({ connState: "offline" });
    expect(w.text()).toContain("设备离线");
  });
});
