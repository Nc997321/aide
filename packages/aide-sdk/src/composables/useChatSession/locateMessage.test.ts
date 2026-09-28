// 变更面板轮次 → 聊天区用户气泡的定位单测。纯函数，只认行模型。
//
// 为什么钉这些用例：轮次标题（ChangeRound.prompt）与气泡文本同源，但**同文本
// 重复提问**（连发两次"继续"）会让纯文本匹配歧义——消歧靠轮次序号，而序号只有
// 在行模型覆盖会话起点时才可信（`fromStart`）。这两条语义错了会静默跳到别的轮次，
// 比找不到更糟，所以正反两面都钉死。
import { describe, it, expect } from "vitest";
import { locateUserMessage } from "./locateMessage";
import type { Row } from "./recycle";
import type { ChatMessage } from "../../types/chat";

function msg(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return { id, role, blocks: [{ type: "text", text }], timestamp: 1 };
}

function pageRow(id: string, messages: ChatMessage[], pageIndex = 0): Row {
  return { kind: "page", id, pageIndex, messages };
}

function liveRow(id: string, message: ChatMessage): Row {
  return { kind: "live", id, message };
}

function skeletonRow(id: string): Row {
  return { kind: "skeleton", id, pageIndex: 0, count: 12, heightPx: 800 };
}

function liveSkeletonRow(id: string): Row {
  return { kind: "liveskel", id, count: 30, heightPx: 3600 };
}

describe("locateUserMessage：轮次 → 用户气泡落点", () => {
  it("唯一命中：返回所在行与行内下标", () => {
    const rows = [
      pageRow("p1", [
        msg("m1", "user", "第一问"),
        msg("m2", "assistant", "答复一"),
        msg("m3", "user", "第二问"),
      ]),
    ];
    expect(locateUserMessage(rows, { prompt: "第二问", roundIndex: 2, fromStart: true }))
      .toEqual({ rowId: "p1", messageIndex: 2 });
  });

  it("跨 page 行与 live 行都能定位（按视觉序）", () => {
    const rows = [
      pageRow("p1", [msg("m1", "user", "老问题"), msg("m2", "assistant", "答复")]),
      liveRow("l1", msg("m3", "user", "新问题")),
      liveRow("l2", msg("m4", "assistant", "新答复")),
    ];
    expect(locateUserMessage(rows, { prompt: "新问题", roundIndex: 2, fromStart: true }))
      .toEqual({ rowId: "l1", messageIndex: 0 });
  });

  it("只认 user 角色：assistant 文本相同不算命中", () => {
    const rows = [pageRow("p1", [msg("m1", "assistant", "继续")])];
    expect(locateUserMessage(rows, { prompt: "继续", roundIndex: 1, fromStart: true })).toBeNull();
  });

  it("跳过 skeleton / liveskel 行（占位行没有消息）", () => {
    const rows = [
      skeletonRow("s1"),
      liveSkeletonRow("ls1"),
      pageRow("p1", [msg("m1", "user", "目标")], 3),
    ];
    expect(locateUserMessage(rows, { prompt: "目标", roundIndex: 1, fromStart: true }))
      .toEqual({ rowId: "p1", messageIndex: 0 });
  });

  it("未命中返回 null", () => {
    const rows = [pageRow("p1", [msg("m1", "user", "别的")])];
    expect(locateUserMessage(rows, { prompt: "不存在", roundIndex: 1, fromStart: true })).toBeNull();
  });

  it("空 prompt 不匹配（ChangeRound.prompt 缺省时的防御）", () => {
    const rows = [pageRow("p1", [msg("m1", "user", "")])];
    expect(locateUserMessage(rows, { prompt: "", roundIndex: 1, fromStart: true })).toBeNull();
  });

  describe("同文本重复提问的消歧", () => {
    const rows = [
      pageRow("p1", [
        msg("m1", "user", "继续"),
        msg("m2", "assistant", "甲"),
        msg("m3", "user", "改别的"),
        msg("m4", "assistant", "乙"),
        msg("m5", "user", "继续"),
      ]),
    ];

    it("fromStart：按轮次序号取第 N 条用户消息（不是第 N 个匹配）", () => {
      // 轮 3 = 会话第 3 条用户消息（下标 4 的 "继续"），不是第 1 条
      expect(locateUserMessage(rows, { prompt: "继续", roundIndex: 3, fromStart: true }))
        .toEqual({ rowId: "p1", messageIndex: 4 });
      // 轮 1 = 第 1 条用户消息（下标 0 的 "继续"）
      expect(locateUserMessage(rows, { prompt: "继续", roundIndex: 1, fromStart: true }))
        .toEqual({ rowId: "p1", messageIndex: 0 });
    });

    it("fromStart 且序号处文本不符 → 回落到文本匹配（历史/改写导致的错位）", () => {
      // 轮 2 按序号是下标 2 的 "改别的"，不是命中集成员 → 序号作废，回落取最后命中
      expect(locateUserMessage(rows, { prompt: "继续", roundIndex: 2, fromStart: true }))
        .toEqual({ rowId: "p1", messageIndex: 4 });
    });

    it("非 fromStart：序号必偏移，不可用于消歧，回落取最后一个命中", () => {
      expect(locateUserMessage(rows, { prompt: "继续", roundIndex: 1, fromStart: false }))
        .toEqual({ rowId: "p1", messageIndex: 4 });
    });

    it("序号越界（轮次比窗口内用户消息多）不采用，同样回落最后一个命中而非抛错", () => {
      // 越界 = 轮次与消息对不上（轮次丢失/消息被截断），序号已不可信；
      // 文本命中仍在，故保守落到最近一次相同提问，不返回 null（用户点的标题确实存在）
      expect(locateUserMessage(rows, { prompt: "继续", roundIndex: 5, fromStart: true }))
        .toEqual({ rowId: "p1", messageIndex: 4 });
    });
  });

  it("单条命中时序号完全无关（越界也照常命中）", () => {
    const rows = [pageRow("p1", [msg("m1", "user", "甲")])];
    expect(locateUserMessage(rows, { prompt: "甲", roundIndex: 99, fromStart: true }))
      .toEqual({ rowId: "p1", messageIndex: 0 });
  });
});
