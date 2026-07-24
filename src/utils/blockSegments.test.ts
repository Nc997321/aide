import { describe, expect, it } from "vitest";
import type { ContentBlock, ToolCallBlock } from "@/types/chat";
import { groupStats, segmentBlocks } from "./blockSegments";

let nextId = 0;
function tool(name: string, over: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return { type: "tool_call", id: `t${nextId++}`, name, input: {}, isPending: false, ...over };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });

describe("segmentBlocks", () => {
  it("空 blocks → 空段", () => {
    expect(segmentBlocks([])).toEqual([]);
  });

  it("连续 tool_call 聚成一组，index 是段首块在原数组的下标", () => {
    const blocks: ContentBlock[] = [text("a"), tool("Read"), tool("Glob"), text("b")];
    const segs = segmentBlocks(blocks);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: "block", index: 0 });
    expect(segs[1]).toMatchObject({ kind: "tool_group", index: 1 });
    expect((segs[1] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual(["Read", "Glob"]);
    expect(segs[2]).toMatchObject({ kind: "block", index: 3 });
  });

  it("单条 tool_call 也成组", () => {
    const segs = segmentBlocks([tool("Read")]);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ kind: "tool_group", index: 0 });
  });

  it("被非工具块打断则开新组（text/subagent 都算打断）", () => {
    const subagent: ContentBlock = {
      type: "subagent", id: "s1", agentName: "Explore", description: "", entries: [], isPending: false,
    };
    const segs = segmentBlocks([tool("Read"), text("x"), tool("Grep"), subagent, tool("Glob"), tool("Glob")]);
    expect(segs.map((s) => s.kind)).toEqual(["tool_group", "block", "tool_group", "block", "tool_group"]);
    expect((segs[4] as { blocks: ToolCallBlock[] }).blocks).toHaveLength(2);
  });

  it("变更类工具（Edit/Write/NotebookEdit）不进折叠组，作为独立块透传并切开两侧查询组", () => {
    const segs = segmentBlocks([
      tool("Read"), tool("Grep"), tool("Edit"), tool("Write"), tool("NotebookEdit"), tool("Glob"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual([
      "tool_group", "block", "block", "block", "tool_group",
    ]);
    expect((segs[0] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual(["Read", "Grep"]);
    expect((segs[1] as { block: ToolCallBlock }).block.name).toBe("Edit");
    expect((segs[2] as { block: ToolCallBlock }).block.name).toBe("Write");
    expect((segs[3] as { block: ToolCallBlock }).block.name).toBe("NotebookEdit");
    expect((segs[4] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual(["Glob"]);
  });

  it("变更块保留原下标作为 index", () => {
    const segs = segmentBlocks([text("a"), tool("Read"), tool("Edit")]);
    expect(segs[2]).toMatchObject({ kind: "block", index: 2 });
  });
});

describe("groupStats", () => {
  it("按次数降序统计种类，累计失败数", () => {
    const stats = groupStats([tool("Read"), tool("Glob"), tool("Read"), tool("Grep", { isError: true })]);
    expect(stats.total).toBe(4);
    expect(stats.errorCount).toBe(1);
    expect(stats.kinds).toEqual([
      { name: "Read", count: 2 },
      { name: "Glob", count: 1 },
      { name: "Grep", count: 1 },
    ]);
  });
});
