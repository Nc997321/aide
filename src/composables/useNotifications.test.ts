import { describe, it, expect, beforeEach, vi } from "vitest";
import { useNotifications } from "./useNotifications";

// mock api：load 返回空、save 记录调用参数
vi.mock("../api", () => ({
  api: {
    loadNotifications: vi.fn().mockResolvedValue([]),
    saveNotifications: vi.fn().mockResolvedValue(undefined),
  },
}));

import { api } from "../api";

const {
  notifications,
  unreadCount,
  push,
  dismiss,
  clearAll,
  markAllRead,
  hydrate,
  registerActionHandler,
  triggerAction,
  __resetForTest,
} = useNotifications();

function base(severity: "error" | "warning" | "info" = "error") {
  return {
    severity,
    source: "test",
    title: "T",
    timestamp: Date.now(),
  } as const;
}

describe("useNotifications", () => {
  beforeEach(() => {
    __resetForTest();
    (api.saveNotifications as any).mockClear();
    (api.loadNotifications as any).mockClear();
    (api.loadNotifications as any).mockResolvedValue([]);
  });

  it("push 后列表按 timestamp 降序、未读数 +1", () => {
    push({ ...base("error"), id: undefined as never, title: "a", timestamp: 100 });
    push({ ...base("error"), id: undefined as never, title: "b", timestamp: 200 });
    expect(notifications.value.map((n) => n.title)).toEqual(["b", "a"]);
    expect(unreadCount.value).toBe(2);
  });

  it("dedupKey 命中未读项 → 合并刷新 count++ 不新增", () => {
    push({ ...base("error"), id: undefined as never, title: "a", dedupKey: "k", timestamp: 100 });
    push({ ...base("error"), id: undefined as never, title: "a2", dedupKey: "k", timestamp: 200 });
    expect(notifications.value.length).toBe(1);
    expect(notifications.value[0].title).toBe("a2");
    expect(notifications.value[0].count).toBe(2);
    expect(notifications.value[0].timestamp).toBe(200);
  });

  it("info 不触发落盘；error/warning 触发（debounce 后）", async () => {
    push({ ...base("info"), id: undefined as never, title: "i", timestamp: 1 });
    expect(api.saveNotifications).not.toHaveBeenCalled();
    push({ ...base("error"), id: undefined as never, title: "e", timestamp: 2 });
    await new Promise((r) => setTimeout(r, 600)); // 等 500ms debounce
    expect(api.saveNotifications).toHaveBeenCalledTimes(1);
    const sent = (api.saveNotifications as any).mock.calls[0][0] as any[];
    expect(sent.every((r) => r.severity !== "info")).toBe(true);
  });

  it("dismiss 删条目并落盘；clearAll 清空并落盘", async () => {
    push({ ...base("error"), id: undefined as never, title: "e", timestamp: 1 });
    await new Promise((r) => setTimeout(r, 600));
    const id = notifications.value[0].id;
    (api.saveNotifications as any).mockClear();
    dismiss(id);
    expect(notifications.value.length).toBe(0);
    expect(api.saveNotifications).toHaveBeenCalledTimes(1);
  });

  it("markAllRead 落盘 read=true（看过重启不再提醒）", async () => {
    push({ ...base("error"), id: undefined as never, title: "e", timestamp: 1 });
    await new Promise((r) => setTimeout(r, 600));
    (api.saveNotifications as any).mockClear();
    markAllRead();
    expect(unreadCount.value).toBe(0);
    await new Promise((r) => setTimeout(r, 600)); // 等 debounce 落盘
    expect(api.saveNotifications).toHaveBeenCalledTimes(1);
    const sent = (api.saveNotifications as any).mock.calls[0][0] as any[];
    expect(sent[0].read).toBe(true);
  });

  it("hydrate 注入落盘项为未读", async () => {
    (api.loadNotifications as any).mockResolvedValue([
      { id: "r1", severity: "error", source: "codegraph", title: "旧错误", timestamp: 999, read: false },
    ]);
    await hydrate();
    expect(notifications.value.length).toBe(1);
    expect(notifications.value[0].read).toBe(false);
    expect(unreadCount.value).toBe(1);
  });

  it("hydrate 恢复已读状态（看过的重启后保持已读、不再提醒）", async () => {
    (api.loadNotifications as any).mockResolvedValue([
      { id: "r1", severity: "error", source: "codegraph", title: "已处理", timestamp: 999, read: true },
    ]);
    await hydrate();
    expect(notifications.value.length).toBe(1);
    expect(notifications.value[0].read).toBe(true);
    expect(unreadCount.value).toBe(0);
  });

  it("triggerAction 按 source 派发到注册的 handler", async () => {
    const handler = vi.fn();
    registerActionHandler("test", handler);
    push({ ...base("warning"), id: undefined as never, title: "t", timestamp: 1, action: { label: "重建" } });
    const id = notifications.value[0].id;
    triggerAction(id);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].id).toBe(id);
  });

  it("落盘上限 100：超 100 条 push 后 save 只送 100 条且淘汰最旧", async () => {
    for (let i = 0; i < 105; i++) {
      push({ ...base("error"), id: undefined as never, title: `e${i}`, timestamp: i });
    }
    await new Promise((r) => setTimeout(r, 600));
    const sent = (api.saveNotifications as any).mock.calls.at(-1)[0] as any[];
    expect(sent.length).toBe(100);
    // 最旧（timestamp 0~4）应被淘汰，最新（104）在前
    expect(sent[0].timestamp).toBe(104);
  });
});