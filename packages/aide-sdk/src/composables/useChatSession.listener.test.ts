import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

import { listen } from "@tauri-apps/api/event";
import { useChatSession, __resetForTest } from "./useChatSession";

/**
 * 回归：chat-event 全局监听器的并发防重入。
 *
 * 事故：分屏功能落地后 App.vue + 各 PaneGroup 在同一 tick 各自调用
 * useChatSession()，旧实现只判「已注册结果」而不是「注册中 promise」，
 * 首个 await listen() 完成前所有调用都穿过空检查 → 重复注册监听器 →
 * 每条流式增量被处理多遍，消息内容成对重复。
 */
describe("useChatSession 全局监听器防重入", () => {
  beforeEach(() => {
    __resetForTest();
    vi.mocked(listen).mockClear();
  });

  it("同一 tick 多实例并发初始化只注册一次监听", async () => {
    useChatSession(ref<string | null>(null));
    useChatSession(ref<string | null>(null));
    useChatSession(ref<string | null>(null));
    // 让注册 promise 走完
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(listen)).toHaveBeenCalledTimes(1);
  });

  it("sendMessage 入口的 ensureGlobalListener 同样复用已注册的监听", async () => {
    const chat = useChatSession(ref<string | null>(null));
    await chat.sendMessage("hi");
    await chat.sendMessage("again");
    expect(vi.mocked(listen)).toHaveBeenCalledTimes(1);
  });
});
