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

  it("连续 tool_call 聚成一组并收进过程胶囊，index 是段首块在原数组的下标", () => {
    const blocks: ContentBlock[] = [text("a"), tool("Read"), tool("Glob"), text("b")];
    const segs = segmentBlocks(blocks);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: "block", index: 0 });
    expect(segs[1]).toMatchObject({ kind: "process", index: 1 });
    const inner = (segs[1] as { segments: Segment[] }).segments;
    expect(inner).toHaveLength(1);
    expect(inner[0]).toMatchObject({ kind: "tool_group", index: 1 });
    expect((inner[0] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual(["Read", "Glob"]);
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
    const segs = segmentBlocks([
      tool("Read"), text("x"), tool("Grep"), subagent, tool("Glob"), tool("Glob"), text("y"),
    ]);
    // text 切断连续段；Grep / 子代理 / 两条 Glob 同属一个连续段 → 一个胶囊，内部仍是三段
    expect(segs.map((s) => s.kind)).toEqual(["tool_group", "block", "process", "block"]);
    const inner = (segs[2] as { segments: Segment[] }).segments;
    expect(inner.map((s) => s.kind)).toEqual(["tool_group", "block", "tool_group"]);
    expect((inner[2] as { blocks: ToolCallBlock[] }).blocks).toHaveLength(2);
  });

  it("变更类工具（Edit/Write/NotebookEdit）与查询工具同为过程项：同组、同进胶囊", () => {
    const glob = tool("Glob");
    const segs = segmentBlocks([
      tool("Read"), tool("Grep"), tool("Edit"), tool("Write"), tool("NotebookEdit"), glob,
    ]);
    // 消息尾是 Glob（当前这一步）留在外面，前面五条成一个胶囊
    expect(segs.map((s) => s.kind)).toEqual(["process", "tool_group"]);
    const inner = (segs[0] as { segments: Segment[] }).segments;
    expect((inner[0] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual([
      "Read", "Grep", "Edit", "Write", "NotebookEdit",
    ]);
    expect(segs[1]).toMatchObject({ kind: "tool_group", currentId: glob.id });
  });

  it("消息尾的 Edit 是「当前这一步」：留在胶囊外、带 currentId", () => {
    const edit = tool("Edit");
    const segs = segmentBlocks([text("a"), tool("Read"), tool("Grep"), edit]);
    expect(segs.map((s) => s.kind)).toEqual(["block", "process", "tool_group"]);
    expect(segs[2]).toMatchObject({ kind: "tool_group", index: 3, currentId: edit.id });
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

describe("segmentBlocks 过程合并", () => {
  it("≥2 个可折叠块的连续段合成一个 process 段，index 取段首原下标", () => {
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

  it("变更类工具不再切断连续段：夹在过程中间的 Edit 一起收进同一个胶囊", () => {
    const segs = segmentBlocks(
      [tool("Read"), thinking("t1"), tool("Edit"), thinking("t2"), tool("Grep"), text("完")],
      { finalized: true },
    );
    expect(segs.map((s) => s.kind)).toEqual(["process", "block"]);
    const inner = (segs[0] as { segments: Segment[] }).segments;
    expect(inner.map((s) => s.kind)).toEqual(["tool_group", "block", "tool_group", "block", "tool_group"]);
    expect((inner[2] as { blocks: ToolCallBlock[] }).blocks[0].name).toBe("Edit");
  });

  it("subagent 块是可折叠过程项：进 process 段，单独存在时不合并", () => {
    const merged = segmentBlocks([subagent("s1"), thinking("t")], { finalized: true });
    expect(merged.map((s) => s.kind)).toEqual(["process"]);

    const single = segmentBlocks([text("a"), subagent("s1"), text("b")], { finalized: true });
    expect(single.map((s) => s.kind)).toEqual(["block", "block", "block"]);
  });

  it("单个工具组按条数计：一串连续工具调用自己就收拢，不必有思考块凑数", () => {
    const segs = segmentBlocks(
      [text("a"), tool("Bash"), tool("Grep"), tool("Glob"), text("b")],
      { finalized: true },
    );
    expect(segs.map((s) => s.kind)).toEqual(["block", "process", "block"]);
  });
});

describe("segmentBlocks 流式期（finalized 缺省/false）", () => {
  it("已落定的过程项照样收拢，缺省与 false 等价", () => {
    const blocks = [tool("Read"), thinking("t"), tool("Grep"), text("回复中")];
    expect(segmentBlocks(blocks).map((s) => s.kind)).toEqual(["process", "block"]);
    expect(segmentBlocks(blocks, { finalized: false }).map((s) => s.kind)).toEqual(["process", "block"]);
  });

  it("未出结果的工具调用留在胶囊外，index 是它自己的原下标", () => {
    const segs = segmentBlocks([tool("Bash"), tool("Grep"), tool("Glob", { isPending: true })]);
    expect(segs.map((s) => s.kind)).toEqual(["process", "tool_group"]);
    expect(segs[1]).toMatchObject({ index: 2 });
    expect((segs[1] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual(["Glob"]);
    // 后面出了正文：活块并入，整段一个胶囊，key（index）不变
    const done = segmentBlocks([tool("Bash"), tool("Grep"), tool("Glob"), text("完")], { finalized: true });
    expect(done.map((s) => s.kind)).toEqual(["process", "block"]);
    expect(done[0].index).toBe(segs[0].index);
  });

  it("并行调用乱序返回：从第一条未出结果的调用处切开，其后一律留在外面", () => {
    const segs = segmentBlocks([
      tool("Read"), tool("Read"), tool("Bash", { isPending: true }), tool("Grep"),
    ]);
    expect(segs.map((s) => s.kind)).toEqual(["process", "tool_group"]);
    expect((segs[1] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual(["Bash", "Grep"]);
  });

  it("只落定一条时不成胶囊：与当前这条同在一个工具组里平铺", () => {
    const segs = segmentBlocks([tool("Read"), tool("Grep", { isPending: true })]);
    expect(segs.map((s) => s.kind)).toEqual(["tool_group"]);
    expect((segs[0] as { blocks: ToolCallBlock[] }).blocks.map((b) => b.name)).toEqual(["Read", "Grep"]);
  });

  it("正在吐字的尾部思考块、仍在跑的子代理留在胶囊外", () => {
    const tail = segmentBlocks([tool("Read"), tool("Grep"), thinking("想到一半")]);
    expect(tail.map((s) => s.kind)).toEqual(["process", "block"]);
    // 同一个思考块不在尾部（后面已有新块）= 已落定，可进胶囊
    const settled = segmentBlocks([tool("Read"), thinking("想完了"), tool("Grep", { isPending: true })]);
    expect(settled.map((s) => s.kind)).toEqual(["process", "tool_group"]);

    const running: ContentBlock = { ...subagent("s1"), isPending: true } as ContentBlock;
    const segs = segmentBlocks([tool("Read"), tool("Grep"), running, text("…")]);
    expect(segs.map((s) => s.kind)).toEqual(["process", "block", "block"]);
  });
});

describe("segmentBlocks 当前这一步（消息尾的命令留在胶囊外）", () => {
  const currentOf = (seg: Segment) => (seg as { currentId?: string }).currentId;

  it("命令跑完但后面还没有任何块：不收，带 currentId", () => {
    const last = tool("Bash");
    const segs = segmentBlocks([tool("Grep"), tool("Glob"), last]);
    expect(segs.map((s) => s.kind)).toEqual(["process", "tool_group"]);
    expect((segs[1] as { blocks: ToolCallBlock[] }).blocks).toEqual([last]);
    expect(currentOf(segs[1])).toBe(last.id);
  });

  it("下一条命令出现的同一次重算里，上一条才让位", () => {
    const a = tool("Grep"), b = tool("Glob"), c = tool("Bash", { isPending: true });
    // 只有 a：留在外面；a+b：a 缩成一行、b 当前；a+b+c：a、b 进胶囊，c 当前
    expect(segmentBlocks([a]).map((s) => s.kind)).toEqual(["tool_group"]);
    const two = segmentBlocks([a, b]);
    expect(two.map((s) => s.kind)).toEqual(["tool_group"]);
    expect(currentOf(two[0])).toBe(b.id);
    const three = segmentBlocks([a, b, c]);
    expect(three.map((s) => s.kind)).toEqual(["process", "tool_group"]);
    expect(currentOf(three[1])).toBe(c.id);
  });

  it("正文出现也算「下一条」：前面的命令让位，不再有 currentId", () => {
    const segs = segmentBlocks([tool("Grep"), tool("Bash"), text("结论")]);
    expect(segs.map((s) => s.kind)).toEqual(["process", "block"]);
    const single = segmentBlocks([tool("Bash"), text("结论")]);
    expect(single.map((s) => s.kind)).toEqual(["tool_group", "block"]);
    expect(currentOf(single[0])).toBeUndefined();
  });

  it("思考出现同样取代前一条命令", () => {
    const segs = segmentBlocks([tool("Grep"), tool("Bash"), thinking("想")]);
    expect(segs.map((s) => s.kind)).toEqual(["process", "block"]);
  });

  it("只有消息尾的那一段有当前项：前面被正文隔开的段全部收拢", () => {
    const segs = segmentBlocks([tool("Grep"), tool("Glob"), text("中间"), tool("Read"), tool("Bash")]);
    expect(segs.map((s) => s.kind)).toEqual(["process", "block", "tool_group"]);
    expect(currentOf(segs[2])).toBe((segs[2] as { blocks: ToolCallBlock[] }).blocks[1].id);
  });

  it("不看 finalized：被打断的回合停在命令上，那条命令留在原位", () => {
    const blocks = [tool("Grep"), tool("Glob"), tool("Bash")];
    expect(segmentBlocks(blocks, { finalized: true }).map((s) => s.kind)).toEqual(["process", "tool_group"]);
  });

  it("消息尾是跑完的子代理：同样留在胶囊外", () => {
    const segs = segmentBlocks([tool("Grep"), tool("Glob"), subagent("s1")], { finalized: true });
    expect(segs.map((s) => s.kind)).toEqual(["process", "block"]);
  });
});

describe("processStats", () => {
  it("统计思考段数 / 子代理数 / 工具种类分布", () => {
    const segs = segmentBlocks(
      [
        tool("Read"), tool("Grep", { isError: true }), thinking("t1"),
        subagent("s1"), thinking("t2"), tool("Glob"), text("完"),
      ],
      { finalized: true },
    );
    expect(segs).toHaveLength(2);
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
