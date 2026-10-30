import { describe, expect, it } from "vitest";
import type { ContentBlock, ToolCallBlock } from "@/types/chat";
import { isChangeTool, processHead, segmentBlocks, type Segment } from "./blockSegments";

let nextId = 0;
function tool(name: string): ToolCallBlock {
  return { type: "tool_call", id: `t${nextId++}`, name, input: {}, isPending: false };
}
const text = (value: string): ContentBlock => ({ type: "text", text: value });
const thinking = (value: string): ContentBlock => ({ type: "thinking", text: value });
const subagent = (): ContentBlock => ({
  type: "subagent", id: "s", agentName: "Explore", description: "查引用", entries: [], isPending: false,
});
function shape(segments: Segment[]): string[] {
  return segments.map(segment => segment.kind === "process"
    ? segment.blocks.map(block => block.type === "tool_call" ? block.name : block.type).join(",")
    : segment.block.type);
}

describe("segmentBlocks（单行过程入口）", () => {
  it("空数组、空白正文不产生空组", () => {
    expect(segmentBlocks([])).toEqual([]);
    expect(segmentBlocks([text("  \n")])).toEqual([]);
  });

  it("不同工具和子代理合为同一个过程组", () => {
    const segments = segmentBlocks([tool("Read"), tool("Grep"), subagent(), tool("Edit")]);
    expect(shape(segments)).toEqual(["Read,Grep,subagent,Edit"]);
    expect(segments[0]).toMatchObject({ index: 0, current: true });
  });

  it("正文和引用卡保留原位，切开过程组；index 使用原始块下标", () => {
    const blocks: ContentBlock[] = [tool("Read"), text("结论"), tool("Bash"), { type: "image", data: "", mediaType: "image/png" }, tool("Edit")];
    const segments = segmentBlocks(blocks);
    expect(shape(segments)).toEqual(["Read", "text", "Bash", "image", "Edit"]);
    expect(segments.map(segment => segment.index)).toEqual([0, 1, 2, 3, 4]);
    expect(segments[0]).toMatchObject({ current: false });
    expect(segments[4]).toMatchObject({ current: true });
  });

  it("正文到达不撤掉当前写入，下一指令才交接", () => {
    const edit = tool("Write");
    expect(segmentBlocks([edit, text("解释")])[0]).toMatchObject({ current: true });
    const segments = segmentBlocks([edit, text("解释"), tool("Read")]);
    expect(segments[0]).toMatchObject({ current: false });
    expect(segments[2]).toMatchObject({ current: true });
  });

  it("结果是否pending不影响当前指令，回答结束后取消所有当前标记", () => {
    for (const isPending of [true, false]) {
      const segments = segmentBlocks([{ ...tool("Edit"), isPending }], { finalized: true });
      expect(segments[0]).toMatchObject({ current: false });
    }
  });

  it("显示思考时思考加入过程，后续思考不提前取代写入标题", () => {
    const segments = segmentBlocks([thinking("先想"), tool("Write"), thinking("再想")], { showThinking: true });
    expect(shape(segments)).toEqual(["thinking,Write,thinking"]);
    const segment = segments[0];
    if (segment.kind !== "process") throw new Error("缺少过程组");
    expect(processHead(segment.blocks)).toMatchObject({ name: "Write" });
    expect(segment.current).toBe(true);
  });

  it("思考正文隐藏：中间思考省略，尾部思考只在流式时保留提示", () => {
    expect(shape(segmentBlocks([tool("Read"), thinking("隐藏"), tool("Grep")]))).toEqual(["Read,Grep"]);
    expect(shape(segmentBlocks([thinking("隐藏"), text("正文")]))).toEqual(["text"]);
    expect(shape(segmentBlocks([thinking("正在想")]))).toEqual(["thinking"]);
    expect(segmentBlocks([thinking("结束")], { finalized: true })).toEqual([]);
  });

  it("只有思考时取最后一个思考块，正文之间只保留最后一组为current", () => {
    const segments = segmentBlocks([thinking("一"), text("正文"), thinking("二"), thinking("三")], { showThinking: true });
    expect(segments[0]).toMatchObject({ current: false });
    const tail = segments[2];
    if (tail.kind !== "process") throw new Error("缺少过程组");
    expect(tail.current).toBe(true);
    expect(processHead(tail.blocks)).toMatchObject({ text: "三" });
  });

  it("正文后的思考不撤掉之前写入的当前状态", () => {
    const segments = segmentBlocks([tool("Edit"), text("解释"), thinking("继续想")], { showThinking: true });
    expect(segments[0]).toMatchObject({ current: true });
    expect(segments[2]).toMatchObject({ current: false });
  });

  it("变更工具名单包含全部写入类型，不把查询当变更", () => {
    for (const name of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) expect(isChangeTool(name)).toBe(true);
    expect(isChangeTool("Read")).toBe(false);
  });
});
