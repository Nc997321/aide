// 值守在 SDK 侧的两件事：回报渲染成卡片；「没有变化」的提示连着来时原地更新、不刷屏。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

let chatEventHandler: ((e: { payload: Record<string, unknown> }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: Record<string, unknown> }) => void) => {
    chatEventHandler = cb;
    return () => {
      chatEventHandler = null;
    };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { useChatSession, __resetForTest } from "./useChatSession";

function emit(e: Record<string, unknown>) {
  chatEventHandler?.({ payload: { session_id: "uuid-w", ...e } });
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

beforeEach(() => __resetForTest());

describe("值守", () => {
  it("值守回报进会话：卡片块，畸形块跳过但消息不消失", async () => {
    const chat = useChatSession(ref<string | null>("uuid-w"));
    await flush();
    emit({
      type: "user_message",
      text: "[值守回报] QQ · 10:32:05",
      display: [
        { type: "watch_report", watchId: "w1", title: "QQ", focus: "新消息", source: "窗口 0x1", at: "10:32:05", kind: "change", added: ["张三：明天三点"], removed: 0 },
        { type: "watch_report", title: "坏块" },
      ],
    });
    await flush();
    const blocks = chat.messages.value.flatMap((m) => m.blocks);
    expect(blocks.filter((b) => b.type === "watch_report")).toHaveLength(1);
  });

  it("同一个值守的「没有变化」原地更新；别的通知照常新起一条", async () => {
    const chat = useChatSession(ref<string | null>("uuid-w"));
    await flush();
    emit({ type: "notification", notification_type: "watch", message: "值守「构建」10:00:00：没有变化" });
    emit({ type: "notification", notification_type: "watch", message: "值守「构建」10:01:00：没有变化" });
    await flush();
    const texts = () => chat.messages.value.flatMap((m) => m.blocks).map((b) => (b.type === "text" ? b.text : ""));
    expect(texts()).toEqual(["值守「构建」10:01:00：没有变化"]);
    emit({ type: "notification", notification_type: "watch", message: "值守「QQ」10:01:05：没有变化" });
    emit({ type: "notification", notification_type: "provider", message: "已切换供应商" });
    await flush();
    expect(texts()).toHaveLength(3);
  });
});
