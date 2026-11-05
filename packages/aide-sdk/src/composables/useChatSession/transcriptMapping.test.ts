// 历史回看路径的 mapping 单测：重点钉住「与实时路径（events.ts 的 display 映射）
// 形状一致」——两条路分叉的典型症状是"实时是目录卡、重开历史变成文件卡"。
import { describe, it, expect } from "vitest";
import { itemsToChatMessages } from "./transcriptMapping";
import type { ToolCallBlock } from "../../types/chat";
import type { ChatMessageItem, HistoryBlock } from "../../types";
import { formatMediaRefsForPrompt } from "../../utils/mediaRefs";

function userItem(text: string): ChatMessageItem {
  const blocks: HistoryBlock[] = [{ type: "text", text }];
  return { role: "user", timestamp: 1, blocks };
}

function cards(items: ChatMessageItem[]): ToolCallBlock[] {
  return itemsToChatMessages(items)[0].blocks.filter(
    (b): b is ToolCallBlock => b.type === "tool_call",
  );
}

describe("history restores images and media references", () => {
  it("keeps the image block and mediaref block in message order", () => {
    const mediaref = { source: { path: "clip.mp4", title: "clip", revision: "rev" }, selection: { kind: "point" as const, atMs: 42 }, frameIndex: 0 };
    const text = `请看截图\n\n${formatMediaRefsForPrompt([mediaref], 1)}`;
    const message = itemsToChatMessages([{
      role: "user", timestamp: 1,
      blocks: [
        { type: "image", data: "YWJj", mediaType: "image/png" },
        { type: "text", text },
      ],
    }])[0];
    expect(message.blocks.map((block) => block.type)).toEqual(["image", "text", "mediaref"]);
    expect(message.blocks[0]).toMatchObject({ type: "image", data: "YWJj", mediaType: "image/png" });
    expect(message.blocks[2]).toMatchObject({ type: "mediaref", ...mediaref });
  });
});

describe("itemsToChatMessages：@引用段拆回附件卡", () => {
  it("目录段 → 合成 Read 卡带 isDir", () => {
    const text = [
      "把调用方一起改掉",
      "",
      "--- 引用目录：C:\\repoB ---",
      "目录：C:\\repoB（已授权访问，可直接 Read/Edit 其中文件）",
      "--- 目录结束：C:\\repoB ---",
    ].join("\n");

    const out = itemsToChatMessages([userItem(text)]);
    expect(out[0].blocks[0]).toMatchObject({ type: "text", text: "把调用方一起改掉" });
    const [card] = cards([userItem(text)]);
    expect(card).toMatchObject({ name: "Read", isDir: true });
    expect(card.input).toEqual({ file_path: "C:\\repoB" });
    expect(card.result).toContain("已授权访问");
  });

  it("文件段不带 isDir（文件引用卡与真 Read 卡都不出「目录」药丸）", () => {
    const text = "看下\n\n--- 引用文件：/a.md ---\n正文\n--- 文件结束：/a.md ---";
    const [card] = cards([userItem(text)]);
    expect(card).toMatchObject({ name: "Read" });
    expect(card.isDir).toBeUndefined();
  });
});
