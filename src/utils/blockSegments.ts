import type { ContentBlock, ToolCallBlock } from "@/types/chat";

/**
 * 消息 blocks 的渲染分段，分两阶段：
 *
 * 一阶段（所有消息）：连续的查询类 tool_call 聚成一个墨线组（ToolCallGroup），
 * 其余块原样透传。index 是段首块在原 blocks 里的下标——既当 v-for 的稳定 key，
 * 也让 ChatMessage 能继续用原始下标判定流式尾块（blockHtml 的缓存策略）。
 *
 * 二阶段（仅定稿消息，opts.finalized）：把 ≥2 个"过程块"的连续段合并成一个
 * process 段（ProcessGroup 胶囊，默认折叠）。过程块 = 思考 / 查询工具组 / 子代理
 * 调用——模型"干活"的痕迹；文本块（回复，无论中间叙述还是最终结论，结构上同为
 * TextBlock，位置即时序）与变更卡永不在段内，它们切断连续段、留在原位。流式期
 * 不传 finalized，分段行为与历史一致（新工具块还能续进尾组），定稿瞬间重算收拢。
 *
 * 例外：代码变更类工具（CHANGE_TOOL_NAMES）不进任何折叠——它们产出的 diff/新文件
 * 内容是要直接被看到的，折叠进胶囊里就得翻两层才能找到。这类块作为独立段透传，
 * 由 ToolCallBlock 以 defaultExpanded 渲染成对话流里的变更卡；顺带把两侧过程段
 * 自然切开（过程段 → 变更卡 → 过程段）。
 */
export type Segment =
  | { kind: "block"; block: ContentBlock; index: number }
  | { kind: "tool_group"; blocks: ToolCallBlock[]; index: number }
  /** 定稿后由 ≥2 个连续过程段合并成的折叠胶囊；segments 保持原序，不会是 process 嵌套。 */
  | { kind: "process"; segments: Segment[]; index: number };

/** 代码变更类工具：不进折叠组，对话流里默认展开成变更卡。 */
export const CHANGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
]);

export function isChangeTool(name: string): boolean {
  return CHANGE_TOOL_NAMES.has(name);
}

/** 可折进 process 胶囊的段：查询工具组 / 思考 / 子代理调用。
 *  文本（回复）与变更卡永远不可折——它们是回合的"产出"，位置即时序。 */
function isProcessFoldable(seg: Segment): boolean {
  if (seg.kind === "tool_group") return true;
  if (seg.kind !== "block") return false;
  return seg.block.type === "thinking" || seg.block.type === "subagent";
}

/** 二阶段合并：每个 ≥2 个可折叠段的连续段合成一个 process 段；单块段原样保留
 *  （单独一个思考/工具组沿用现有胶囊/卡片，不值得再多套一层点击）。 */
function mergeProcessRuns(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  let run: Segment[] = [];
  const flush = () => {
    if (run.length >= 2) {
      out.push({ kind: "process", segments: run, index: run[0].index });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const seg of segments) {
    if (isProcessFoldable(seg)) {
      run.push(seg);
    } else {
      flush();
      out.push(seg);
    }
  }
  flush();
  return out;
}

export function segmentBlocks(blocks: ContentBlock[], opts?: { finalized?: boolean }): Segment[] {
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
  return opts?.finalized ? mergeProcessRuns(segments) : segments;
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

/** process 胶囊收起态摘要所需的统计：思考段数、工具调用总数/失败数、子代理数。 */
export interface ProcessStats {
  thinkingCount: number;
  toolTotal: number;
  toolErrorCount: number;
  subagentCount: number;
}

export function processStats(segments: Segment[]): ProcessStats {
  let thinkingCount = 0;
  let toolTotal = 0;
  let toolErrorCount = 0;
  let subagentCount = 0;
  for (const seg of segments) {
    if (seg.kind === "tool_group") {
      toolTotal += seg.blocks.length;
      for (const b of seg.blocks) if (b.isError) toolErrorCount++;
    } else if (seg.kind === "block") {
      if (seg.block.type === "thinking") thinkingCount++;
      else if (seg.block.type === "subagent") subagentCount++;
    }
  }
  return { thinkingCount, toolTotal, toolErrorCount, subagentCount };
}
