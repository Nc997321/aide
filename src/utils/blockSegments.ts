import type { ContentBlock, ToolCallBlock } from "@/types/chat";

/**
 * 消息 blocks 的渲染分段（所有 assistant 消息）。
 *
 * 连续的"过程项"构成一个连续段。过程项 = 思考 / 查询工具调用 / 子代理调用——模型
 * "干活"的痕迹。文本块（回复，无论中间叙述还是最终结论，结构上同为 TextBlock，
 * 位置即时序）与变更卡永不在段内，它们切断连续段、留在原位。
 *
 * **收拢的触发点是"后面有东西显示出来了"，不是"这一条跑完了"**（2026-10-12）：
 * 消息的最后一块若是命令（工具调用 / 子代理），它就是"当前这一步"，带结果预览留在
 * 胶囊外；它后面一旦出现任何块——下一条命令、思考、或回复正文——才在同一次重算里
 * 让位。此前（2026-10-10）是"出了结果就收"，命令刚跑完、下一块还没出现，画面上就
 * 先空了一拍，读起来不连贯。被取代的部分合计 ≥2 项才成 process 段（ProcessGroup
 * 胶囊，默认折叠）；只有 1 项时留在外面缩成一行（没有预览），不值得多套一层点击。
 *
 * 这条规则不看 finalized：回合总是以回复正文收尾，定稿时自然没有命令挂在外面；
 * 被打断的回合停在命令上，那条命令留在原位。
 *
 * 流式期（不传 finalized）在此之上再把"还活着"的块留在胶囊外：未出结果的工具
 * 调用（并行调用可能乱序返回，从第一条未出结果的调用处切开，其后一律留在外面，
 * 保证原序不被打乱）、仍在跑的子代理、正在吐字的尾部思考块。
 *
 * 连续的查询类 tool_call 聚成一个 tool_group 段。该段不对应某个折叠组件——渲染时
 * 逐条平铺（留在胶囊外的与 ProcessGroup 展开体内的皆然）。
 * index 是段首块在原 blocks 里的下标——既当 v-for 的稳定 key，
 * 也让 ChatMessage 能继续用原始下标判定流式尾块（blockHtml 的缓存策略）。
 *
 * 代码变更类工具（Edit/Write/NotebookEdit）与查询工具同等对待（2026-10-16）：同样
 * 是过程项、同样的「当前这一步」规则，当前这一步的预览是 diff 片段而不是结果正文
 * （见 ToolCallBlock）。此前它们不进折叠、默认展开成整块变更卡，理由是「diff 要直接
 * 被看到」——回合变更结算卡（TurnChangeCard，2026-09-24）接手了这件事：一轮改了
 * 哪些文件统一在消息尾结算，过程里再逐块摊开就是第二份，一轮改八个文件就是八张大卡。
 */
export type Segment =
  | { kind: "block"; block: ContentBlock; index: number }
  /** currentId：组内那条"当前这一步"的工具调用（它是消息的最后一块），渲染时带结果
   *  预览；组里没有它（后面已有别的块 / 在胶囊里）则缺省。 */
  | { kind: "tool_group"; blocks: ToolCallBlock[]; index: number; currentId?: string }
  /** 合计 ≥2 个过程项的连续段合并成的折叠胶囊；segments 保持原序，不会是 process 嵌套。 */
  | { kind: "process"; segments: Segment[]; index: number };

/** 代码变更类工具：工具行头带 +N −M 与「打开」，预览 / 展开体是 diff。 */
export const CHANGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
]);

export function isChangeTool(name: string): boolean {
  return CHANGE_TOOL_NAMES.has(name);
}

/** 连续段里的一项：块 + 它在原 blocks 里的下标。 */
interface RunItem {
  block: ContentBlock;
  index: number;
}

/** 可进连续段的块：工具调用 / 思考 / 子代理调用。
 *  文本（回复）永远不可折——它是回合的"产出"，位置即时序。 */
function isProcessItem(block: ContentBlock): boolean {
  return block.type === "tool_call" || block.type === "thinking" || block.type === "subagent";
}

/** 命令 = 能当"当前这一步"的过程项。思考不算——它自己就是折叠胶囊，没有结果可预览。 */
function isCommand(block: ContentBlock): boolean {
  return block.type === "tool_call" || block.type === "subagent";
}

/** 流式期"还活着"的项：未出结果的工具调用、仍在跑的子代理、正在吐字的尾部思考块。 */
function isLive(item: RunItem, lastIndex: number): boolean {
  const b = item.block;
  if (b.type === "tool_call" || b.type === "subagent") return b.isPending;
  return b.type === "thinking" && item.index === lastIndex;
}

/** 把一串过程项排成段：连续的工具调用聚成 tool_group，其余各自成 block 段。 */
function toSegments(items: RunItem[], currentId?: string): Segment[] {
  const out: Segment[] = [];
  for (const { block, index } of items) {
    if (block.type !== "tool_call") {
      out.push({ kind: "block", block, index });
      continue;
    }
    let group = out[out.length - 1];
    if (group?.kind !== "tool_group") {
      group = { kind: "tool_group", blocks: [], index };
      out.push(group);
    }
    group.blocks.push(block);
    if (block.id === currentId) group.currentId = currentId;
  }
  return out;
}

/** 一个连续段 → 段列表：切点之前是"已被取代"的部分（≥2 项成胶囊），切点起留在外面。
 *  lastIndex = 消息最后一块的下标；streaming = 流式期（活块也要留在外面）。 */
function segmentRun(run: RunItem[], lastIndex: number, streaming: boolean): Segment[] {
  const tail = run[run.length - 1];
  // 当前这一步：段尾就是消息尾、且是命令。后面只要还有块，它就已被取代
  const current = tail.index === lastIndex && isCommand(tail.block) ? tail.block : undefined;
  let cut = current ? run.length - 1 : run.length;
  if (streaming) {
    const firstLive = run.findIndex((item) => isLive(item, lastIndex));
    if (firstLive !== -1) cut = Math.min(cut, firstLive);
  }
  const currentId = current?.type === "tool_call" ? current.id : undefined;
  // 不成胶囊时整段一起排——被取代的那一条与当前这条若相邻，仍在同一个 tool_group 里
  if (cut < 2) return toSegments(run, currentId);
  return [
    { kind: "process", segments: toSegments(run.slice(0, cut)), index: run[0].index },
    ...toSegments(run.slice(cut), currentId),
  ];
}

export function segmentBlocks(blocks: ContentBlock[], opts?: { finalized?: boolean }): Segment[] {
  const lastIndex = blocks.length - 1;
  const streaming = !opts?.finalized;
  const segments: Segment[] = [];
  let run: RunItem[] = [];
  const flush = () => {
    if (run.length === 0) return;
    segments.push(...segmentRun(run, lastIndex, streaming));
    run = [];
  };
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (isProcessItem(block)) {
      run.push({ block, index });
    } else {
      flush();
      segments.push({ kind: "block", block, index });
    }
  }
  flush();
  return segments;
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
