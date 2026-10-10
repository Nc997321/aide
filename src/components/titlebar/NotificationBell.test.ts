// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

// mock shell open（NotificationBell 仅在 onAction 用，不参与本测试）
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

// mock api（useNotifications 落盘/读取；本测试不关心落盘，给空实现）
vi.mock("../../api", () => ({
  api: {
    loadNotifications: vi.fn().mockResolvedValue([]),
    saveNotifications: vi.fn().mockResolvedValue(undefined),
  },
}));

import NotificationBell from "./NotificationBell.vue";
import { useNotifications } from "../../composables/useNotifications";

const { push, unreadCount, __resetForTest } = useNotifications();

describe("NotificationBell 点击展开", () => {
  beforeEach(() => {
    __resetForTest();
  });

  it("无未读时点击 bell-btn 应打开面板", async () => {
    const w = mount(NotificationBell, { attachTo: document.body });
    expect(unreadCount.value).toBe(0);
    await w.find(".bell-btn").trigger("click");
    await w.vm.$nextTick();
    expect(w.find(".notif-panel").exists()).toBe(true);
    w.unmount();
  });

  it("有未读时点击 bell-btn 应打开面板并清零未读", async () => {
    push({ severity: "error", source: "test", title: "T", timestamp: 1 });
    const w = mount(NotificationBell, { attachTo: document.body });
    expect(unreadCount.value).toBe(1);
    expect(w.find(".bell-badge").exists()).toBe(true);

    await w.find(".bell-btn").trigger("click");
    await w.vm.$nextTick();

    // 未读被 markAllRead 清零
    expect(unreadCount.value).toBe(0);
    // 面板应渲染——这是用户报告失效的场景
    expect(w.find(".notif-panel").exists()).toBe(true);
    w.unmount();
  });

  // 用户实际点击常落在 bell-btn 内的子元素（svg path / badge span）上，
  // 而非 bell-btn 本身。覆盖该路径。
  it("有未读时点击 badge 子元素也应打开面板", async () => {
    push({ severity: "error", source: "test", title: "T", timestamp: 1 });
    const w = mount(NotificationBell, { attachTo: document.body });
    const badge = w.find(".bell-badge");
    expect(badge.exists()).toBe(true);

    await badge.trigger("click");
    await w.vm.$nextTick();

    expect(unreadCount.value).toBe(0);
    expect(w.find(".notif-panel").exists()).toBe(true);
    w.unmount();
  });

  // suppressDocClick 不能误伤 outside-click：面板打开后点外部仍应关闭。
  it("面板打开后点击外部应关闭", async () => {
    const w = mount(NotificationBell, { attachTo: document.body });
    await w.find(".bell-btn").trigger("click");
    await w.vm.$nextTick();
    expect(w.find(".notif-panel").exists()).toBe(true);

    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();
    expect(w.find(".notif-panel").exists()).toBe(false);
    outside.remove();
    w.unmount();
  });

  it("再次点击 bell-btn 应关闭面板", async () => {
    const w = mount(NotificationBell, { attachTo: document.body });
    await w.find(".bell-btn").trigger("click");
    await w.vm.$nextTick();
    expect(w.find(".notif-panel").exists()).toBe(true);
    await w.find(".bell-btn").trigger("click");
    await w.vm.$nextTick();
    expect(w.find(".notif-panel").exists()).toBe(false);
    w.unmount();
  });
});

describe("NotificationBell 角标颜色 = 未读里最严重的一级", () => {
  beforeEach(() => {
    __resetForTest();
  });

  function badgeClasses(): string[] {
    const w = mount(NotificationBell, { attachTo: document.body });
    const classes = w.find(".bell-badge").classes();
    w.unmount();
    return classes;
  }

  it("只有 info（如「插件有更新」）：蓝色，不拉红色警报", () => {
    push({ severity: "info", source: "test", title: "更新", timestamp: 1 });
    expect(badgeClasses()).toContain("sev-info");
    expect(badgeClasses()).not.toContain("sev-error");
  });

  it("info + warning：黄色", () => {
    push({ severity: "info", source: "test", title: "A", timestamp: 1 });
    push({ severity: "warning", source: "test", title: "B", timestamp: 2 });
    expect(badgeClasses()).toContain("sev-warning");
  });

  it("有 error 才红", () => {
    push({ severity: "warning", source: "test", title: "A", timestamp: 1 });
    push({ severity: "error", source: "test", title: "B", timestamp: 2 });
    expect(badgeClasses()).toContain("sev-error");
  });
});
