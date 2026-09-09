import { describe, expect, it } from "vitest";
import type { ContentBlock, ToolCallBlock } from "@/types/chat";
import { groupStats, processStats, segmentBlocks, type Segment } from "./blockSegments";

let nextId = 0;
function tool(name: string, over: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return { type: "tool_call", id: `t${nextId++}`, name, input: {}, isPending: false, ...over };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const thinking = (t: string): ContentBlock => ({ type: "thinking", text: t });
const subagent = (id: string): ContentBlock => ({
  type: "subagent", id, agentName: "Explore", description: "", entries: [], isPending: false,
});

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
  it("按次数降序统计种类", () => {
    const stats = groupStats([tool("Read"), tool("Glob"), tool("Read"), tool("Grep", { isError: true })]);
    expect(stats.kinds).toEqual([
      { name: "Read", count: 2 },
      { name: "Glob", count: 1 },
      { name: "Grep", count: 1 },
    ]);
  });
});

describe("segmentBlocks 过程合并（finalized）", () => {
  it("finalized 时 ≥2 个可折叠块的连续段合成一个 process 段，index 取段首原下标", () => {
    const segs = segmentBlocks(
      [text("a"), tool("Read"), thinking("t1"), tool("Grep"), text("b")],
      { finalized: true },
    );
    expect(segs.map((s) => s.kind)).toEqual(["block", "process", "block"]);
    const p = segs[1] as { segments: Segment[]; index: number };
    expect(p.index).toBe(1);
    expect(p.segments.map((s) => s.kind)).toEqual(["tool_group", "block", "tool_group"]);
  });

  it("回复（text）永不进 process 段，留在原位", () => {
    const segs = segmentBlocks(
      [thinking("t1"), tool("Read"), text("中间回复"), thinking("t2"), tool("Grep"), text("正式回复")],
      { finalized: true },
    );
    expect(segs.map((s) => s.kind)).toEqual(["process", "block", "process", "block"]);
    expect((segs[1] as { block: ContentBlock }).block).toMatchObject({ type: "text", text: "中间回复" });
    expect((segs[3] as { block: ContentBlock }).block).toMatchObject({ type: "text", text: "正式回复" });
  });

  it("单块段不合并：只有一个思考/一个工具组时保持原组件", () => {
    expect(
      segmentBlocks([text("a"), thinking("t"), text("b")], { finalized: true }).map((s) => s.kind),
    ).toEqual(["block", "block", "block"]);
    expect(
      segmentBlocks([text("a"), tool("Read"), text("b")], { finalized: true }).map((s) => s.kind),
    ).toEqual(["block", "tool_group", "block"]);
  });

  it("变更卡（Edit/Write/NotebookEdit）切断连续段：两侧单块段不合并，长段各自成 process", () => {
    const shortRuns = segmentBlocks([tool("Read"), tool("Edit"), tool("Grep")], { finalized: true });
    expect(shortRuns.map((s) => s.kind)).toEqual(["tool_group", "block", "tool_group"]);

    const longRuns = segmentBlocks(
      [tool("Read"), thinking("t1"), tool("Edit"), thinking("t2"), tool("Grep")],
      { finalized: true },
    );
    expect(longRuns.map((s) => s.kind)).toEqual(["process", "block", "process"]);
    expect((longRuns[1] as { block: ToolCallBlock }).block.name).toBe("Edit");
  });

  it("subagent 块是可折叠过程项：进 process 段，单独存在时不合并", () => {
    const merged = segmentBlocks([subagent("s1"), thinking("t")], { finalized: true });
    expect(merged.map((s) => s.kind)).toEqual(["process"]);

    const single = segmentBlocks([text("a"), subagent("s1"), text("b")], { finalized: true });
    expect(single.map((s) => s.kind)).toEqual(["block", "block", "block"]);
  });

  it("finalized 缺省/false（流式中）不合并，行为与现状一致", () => {
    const blocks = [tool("Read"), thinking("t"), tool("Grep")];
    expect(segmentBlocks(blocks).map((s) => s.kind)).toEqual(["tool_group", "block", "tool_group"]);
    expect(segmentBlocks(blocks, { finalized: false }).map((s) => s.kind)).toEqual([
      "tool_group", "block", "tool_group",
    ]);
  });
});

describe("processStats", () => {
  it("统计思考段数 / 子代理数 / 工具种类分布", () => {
    const segs = segmentBlocks(
      [
        tool("Read"), tool("Grep", { isError: true }), thinking("t1"),
        subagent("s1"), thinking("t2"), tool("Glob"),
      ],
      { finalized: true },
    );
    expect(segs).toHaveLength(1);
    const stats = processStats((segs[0] as { segments: Segment[] }).segments);
    expect(stats).toEqual({
      thinkingCount: 2,
      subagentCount: 1,
      // 次数相同时按出现顺序（Read → Grep → Glob），groupStats 的排序是稳定的
      kinds: [
        { name: "Read", count: 1 },
        { name: "Grep", count: 1 },
        { name: "Glob", count: 1 },
      ],
    });
  });

  it("无思考/无工具时为 0", () => {
    const stats = processStats([
      { kind: "tool_group", blocks: [tool("Read")], index: 0 },
    ]);
    expect(stats).toEqual({
      thinkingCount: 0,
      subagentCount: 0,
      kinds: [{ name: "Read", count: 1 }],
    });
  });
});
