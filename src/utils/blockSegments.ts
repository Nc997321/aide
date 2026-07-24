import type { ContentBlock, ToolCallBlock } from "@/types/chat";

/**
 * 消息 blocks 的渲染分段：连续的 tool_call 聚成一个墨线组（ToolCallGroup），
 * 其余块原样透传。index 是段首块在原 blocks 里的下标——既当 v-for 的稳定 key，
 * 也让 ChatMessage 能继续用原始下标判定流式尾块（blockHtml 的缓存策略）。
 *
 * 例外：代码变更类工具（CHANGE_TOOL_NAMES）不折叠进组——它们产出的 diff/新文件
 * 内容是要直接被看到的，折叠进「N 次工具调用」胶囊里就得翻两层才能找到。这类块
 * 作为独立段透传，由 ToolCallBlock 以 defaultExpanded 渲染成对话流里的变更卡；
 * 顺带把两侧查询组自然切开（查询组 → 变更卡 → 查询组）。
 */
export type Segment =
  | { kind: "block"; block: ContentBlock; index: number }
  | { kind: "tool_group"; blocks: ToolCallBlock[]; index: number };

/** 代码变更类工具：不进折叠组，对话流里默认展开成变更卡。 */
export const CHANGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
]);

export function isChangeTool(name: string): boolean {
  return CHANGE_TOOL_NAMES.has(name);
}

export function segmentBlocks(blocks: ContentBlock[]): Segment[] {
  const segments: Segment[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === "tool_call" && !isChangeTool(block.name)) {
      const last = segments[segments.length - 1];
      if (last?.kind === "tool_group") {
        last.blocks.push(block);
      } else {
        segments.push({ kind: "tool_group", blocks: [block], index: i });
      }
    } else {
      segments.push({ kind: "block", block, index: i });
    }
  }
  return segments;
}

/** 工具组收起态摘要所需的统计：总数、失败数、按次数降序的种类分布。 */
export interface GroupStats {
  total: number;
  errorCount: number;
  kinds: { name: string; count: number }[];
}

export function groupStats(blocks: ToolCallBlock[]): GroupStats {
  const counts = new Map<string, number>();
  let errorCount = 0;
  for (const b of blocks) {
    counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
    if (b.isError) errorCount++;
  }
  const kinds = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { total: blocks.length, errorCount, kinds };
}
