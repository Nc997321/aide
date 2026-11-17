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
    const segments = segmentBlocks([tool("Read"), tool("Grep"), subagent(), tool("Bash")]);
    expect(shape(segments)).toEqual(["Read,Grep,subagent,Bash"]);
    expect(segments[0]).toMatchObject({ index: 0, current: true });
  });

  it("正文、变更和引用卡保留原位，切开过程组", () => {
    const blocks: ContentBlock[] = [tool("Read"), tool("Edit"), text("说明"), tool("Write"), { type: "image", data: "", mediaType: "image/png" }, tool("Bash")];
    for (const finalized of [false, true]) {
      const segments = segmentBlocks(blocks, { finalized });
      expect(shape(segments)).toEqual(["Read", "tool_call", "text", "tool_call", "image", "Bash"]);
      expect(segments.map(segment => segment.index)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(segments[0]).toMatchObject({ current: false });
      expect(segments[5]).toMatchObject({ current: !finalized });
    }
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

  it("变更工具名单包含全部写入类型，不把查询当变更", () => {
    for (const name of ["Edit", "MultiEdit", "Write", "NotebookEdit"]) expect(isChangeTool(name)).toBe(true);
    expect(isChangeTool("Read")).toBe(false);
  });
});
