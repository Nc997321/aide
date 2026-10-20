import { describe, expect, it } from "vitest";
import type { ContentBlock, ToolCallBlock } from "@/types/chat";
import { segmentBlocks, type Segment } from "./blockSegments";

let nextId = 0;
function tool(name: string, over: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return { type: "tool_call", id: `t${nextId++}`, name, input: {}, isPending: false, ...over };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const thinking = (t: string): ContentBlock => ({ type: "thinking", text: t });
const subagent = (id: string): ContentBlock => ({
  type: "subagent", id, agentName: "Explore", description: "", entries: [], isPending: false,
});

/** 段的简写：narration → "N:Read,Read"，block → 块类型，thinking_live → "…" */
function shape(segs: Segment[]): string[] {
  return segs.map((s) =>
    s.kind === "narration" ? `N:${s.blocks.map((b) => b.name).join(",")}` : s.kind === "block" ? s.block.type : "…",
  );
}

describe("segmentBlocks（旁白）", () => {
  it("空 blocks → 空段", () => {
    expect(segmentBlocks([])).toEqual([]);
  });

  it("相邻同类调用合成一句；别类另起一句", () => {
    const segs = segmentBlocks([tool("Read"), tool("Read"), tool("Grep"), tool("Read")], { finalized: true });
    expect(shape(segs)).toEqual(["N:Read,Read", "N:Grep", "N:Read"]);
  });

  it("Grep 与 Glob 同属搜索，合成一句；Edit 与 Write 同属修改", () => {
    const segs = segmentBlocks([tool("Grep"), tool("Glob"), tool("Edit"), tool("Write")], { finalized: true });
    expect(shape(segs)).toEqual(["N:Grep,Glob", "N:Edit,Write"]);
  });

  it("内置浏览器的各种动作合成一句（始终一行）", () => {
    const segs = segmentBlocks(
      [tool("mcp__aide-browser__browser_tab"), tool("mcp__aide-browser__browser_read"), tool("mcp__aide-browser__browser_act")],
      { finalized: true },
    );
    expect(shape(segs)).toEqual(["N:mcp__aide-browser__browser_tab,mcp__aide-browser__browser_read,mcp__aide-browser__browser_act"]);
  });

  it("不同的第三方 MCP 不合并；同一个合并", () => {
    const segs = segmentBlocks(
      [tool("mcp__figma__get_file"), tool("mcp__figma__get_node"), tool("mcp__github__list_prs")],
      { finalized: true },
    );
    expect(shape(segs)).toEqual(["N:mcp__figma__get_file,mcp__figma__get_node", "N:mcp__github__list_prs"]);
  });

  it("正文、子代理切断合并", () => {
    const segs = segmentBlocks([tool("Read"), text("a"), tool("Read"), subagent("s"), tool("Read")], { finalized: true });
    expect(shape(segs)).toEqual(["N:Read", "text", "N:Read", "subagent", "N:Read"]);
  });

  it("思考隐藏（默认）：不渲染、也不切断合并", () => {
    const segs = segmentBlocks([tool("Read"), thinking("想"), tool("Read")], { finalized: true });
    expect(shape(segs)).toEqual(["N:Read,Read"]);
  });

  it("思考显示：原位渲染并切断合并", () => {
    const segs = segmentBlocks([tool("Read"), thinking("想"), tool("Read")], { finalized: true, showThinking: true });
    expect(shape(segs)).toEqual(["N:Read", "thinking", "N:Read"]);
  });

  it("思考隐藏但正在流式思考（最后一块）→ 一行「正在思考…」；不是最后一块就没有", () => {
    expect(shape(segmentBlocks([tool("Read"), thinking("想")]))).toEqual(["N:Read", "…"]);
    expect(shape(segmentBlocks([thinking("想"), text("a")]))).toEqual(["text"]);
    // 定稿后不留
    expect(shape(segmentBlocks([tool("Read"), thinking("想")], { finalized: true }))).toEqual(["N:Read"]);
  });

  it("current：段的最后一块是消息最后一块", () => {
    const segs = segmentBlocks([tool("Read"), text("a"), tool("Bash"), tool("Bash")]);
    expect(segs[0]).toMatchObject({ kind: "narration", current: false });
    expect(segs[2]).toMatchObject({ kind: "narration", current: true, index: 2 });
    const later = segmentBlocks([tool("Bash"), text("b")]);
    expect(later[0]).toMatchObject({ current: false });
  });

  it("index 是段首块在原数组里的下标", () => {
    const segs = segmentBlocks([text("a"), tool("Read"), tool("Read"), text("b")], { finalized: true });
    expect(segs.map((s) => s.index)).toEqual([0, 1, 3]);
  });
});
