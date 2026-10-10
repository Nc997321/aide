import type { ContentBlock, ToolCallBlock } from "@/types/chat";

/**
 * 消息 blocks 的渲染分段，分两阶段：
 *
 * 一阶段：连续的查询类 tool_call 聚成一个 tool_group 段，其余块原样透传。该段不
 * 对应某个折叠组件——渲染时逐条平铺（留在胶囊外的与 ProcessGroup 展开体内的皆然），
 * 它的职责是二阶段的合并判定。
 * index 是段首块在原 blocks 里的下标——既当 v-for 的稳定 key，
 * 也让 ChatMessage 能继续用原始下标判定流式尾块（blockHtml 的缓存策略）。
 *
 * 二阶段（所有 assistant 消息）：把合计 ≥2 个"过程项"的连续段合并成一个 process 段
 * （ProcessGroup 胶囊，默认折叠）。过程项 = 思考 / 查询工具调用 / 子代理调用——模型
 * "干活"的痕迹；**工具组按组内条数计**，所以一串连续的 Bash/Grep/Glob 自己就够收拢，
 * 不必等旁边有思考块凑数（2026-10-10：此前按"段"计，单个工具组无论多少条都平铺，
 * 长回合里刷屏）。文本块（回复，无论中间叙述还是最终结论，结构上同为 TextBlock，
 * 位置即时序）与变更卡永不在段内，它们切断连续段、留在原位。
 *
 * 流式期（不传 finalized）同样收拢，只把"还活着"的块留在胶囊外：未出结果的工具
 * 调用、仍在跑的子代理、正在吐字的尾部思考块——"正在干什么"始终看得见，干完的才
 * 进摘要行。活块落定后在下一次重算时并入前面的胶囊（胶囊 index 取段首，key 稳定）。
 *
 * 例外：代码变更类工具（CHANGE_TOOL_NAMES）不进任何折叠——它们产出的 diff/新文件
 * 内容是要直接被看到的，折叠进胶囊里就得翻两层才能找到。这类块作为独立段透传，
 * 由 ToolCallBlock 以 defaultExpanded 渲染成对话流里的变更卡；顺带把两侧过程段
 * 自然切开（过程段 → 变更卡 → 过程段）。
 */
export type Segment =
  | { kind: "block"; block: ContentBlock; index: number }
  | { kind: "tool_group"; blocks: ToolCallBlock[]; index: number }
  /** 合计 ≥2 个过程项的连续段合并成的折叠胶囊；segments 保持原序，不会是 process 嵌套。 */
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

/** 段内过程项数：工具组按条数计，思考/子代理各算一项。 */
function processItemCount(seg: Segment): number {
  return seg.kind === "tool_group" ? seg.blocks.length : 1;
}

/** 流式期把一个可折叠段拆成「已落定（可进胶囊）」与「还活着（留在外面）」两部分。
 *  工具组从第一条未出结果的调用处切开——并行调用可能乱序返回，但切点之后一律留在
 *  外面，保证原序不被打乱；活的那半段 index 相应后移，仍是它段首块的原下标。 */
function splitLive(seg: Segment, lastIndex: number): { settled?: Segment; live?: Segment } {
  if (seg.kind === "tool_group") {
    const cut = seg.blocks.findIndex((b) => b.isPending);
    if (cut === -1) return { settled: seg };
    if (cut === 0) return { live: seg };
    return {
      settled: { kind: "tool_group", blocks: seg.blocks.slice(0, cut), index: seg.index },
      live: { kind: "tool_group", blocks: seg.blocks.slice(cut), index: seg.index + cut },
    };
  }
  if (seg.kind !== "block") return { settled: seg };
  const live =
    seg.block.type === "subagent"
      ? seg.block.isPending
      : seg.block.type === "thinking" && seg.index === lastIndex;
  return live ? { live: seg } : { settled: seg };
}

/** 二阶段合并：每个合计 ≥2 个过程项的连续段合成一个 process 段；只有一项的原样保留
 *  （单独一个思考/一条工具调用沿用现有胶囊/卡片，不值得再多套一层点击）。
 *  liveTail 非空 = 流式期，值为消息最后一块的下标（判定尾部思考块是否还在吐字）。 */
function mergeProcessRuns(segments: Segment[], liveTail: number | null): Segment[] {
  const out: Segment[] = [];
  let run: Segment[] = [];
  const flush = () => {
    const items = run.reduce((sum, seg) => sum + processItemCount(seg), 0);
    if (items >= 2) {
      out.push({ kind: "process", segments: run, index: run[0].index });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const seg of segments) {
    if (!isProcessFoldable(seg)) {
      flush();
      out.push(seg);
      continue;
    }
    const { settled, live } = liveTail === null ? { settled: seg, live: undefined } : splitLive(seg, liveTail);
    if (settled) run.push(settled);
    if (live) {
      flush();
      out.push(live);
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
  return mergeProcessRuns(segments, opts?.finalized ? null : blocks.length - 1);
}

/** 一组工具调用按次数降序的种类分布。 */
export interface GroupStats {
  kinds: { name: string; count: number }[];
}

export function groupStats(blocks: ToolCallBlock[]): GroupStats {
  const counts = new Map<string, number>();
  for (const b of blocks) {
    counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
  }
  const kinds = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return { kinds };
}

/** process 胶囊收起态摘要所需的统计：思考段数、子代理数、工具种类分布。 */
export interface ProcessStats {
  thinkingCount: number;
  subagentCount: number;
  /** 跨 tool_group 段聚合的种类分布（按次数降序）——过程内工具组不再各自折叠后，
   *  原先由组内摘要承载的"调用了什么"上提到过程摘要行，故在此一并统计。
   *  不单独统计工具总数：摘要逐项列出各类型次数，总数由分布相加即可得出；
   *  种类过多被折叠时由 UI 把剩余项合并成「其余 N 项 ×M」，总数仍可加总。 */
  kinds: { name: string; count: number }[];
}

export function processStats(segments: Segment[]): ProcessStats {
  let thinkingCount = 0;
  let subagentCount = 0;
  const toolBlocks: ToolCallBlock[] = [];
  for (const seg of segments) {
    if (seg.kind === "tool_group") {
      toolBlocks.push(...seg.blocks);
    } else if (seg.kind === "block") {
      if (seg.block.type === "thinking") thinkingCount++;
      else if (seg.block.type === "subagent") subagentCount++;
    }
  }
  return {
    thinkingCount,
    subagentCount,
    kinds: groupStats(toolBlocks).kinds,
  };
}
