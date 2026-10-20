import type { ContentBlock, ToolCallBlock } from "@/types/chat";
import { narrationKey } from "@aide/sdk/utils/narration";

/**
 * assistant 消息 blocks 的渲染分段（2026-10-20 旁白改版，取代过程卡）。
 *
 * 工具调用不再收进折叠的「过程卡」，而是逐句说出来（旁白，见 @aide/sdk/utils/narration）：
 * **相邻的同一类**调用（narrationKey 相同）合成一个 narration 段，渲染成一句话；
 * 中间隔了正文、子代理、别类操作或（显示中的）思考，就另起一句。
 *
 * 思考由「显示思考过程」开关决定（默认关）：
 * - 开：思考块原位渲染，和正文一样会切断合并；
 * - 关：思考块不渲染、**也不切断合并**（看不见的东西不该把一句话劈成两句）；只有消息
 *   还在流式、且最后一块就是思考时，给一个 thinking_live 段，显示「正在思考…」。
 *
 * current：段的最后一块就是消息的最后一块——「当前这一步」，单条时带结果预览（命令的
 * 最新输出、修改的 diff 片段，见 ToolCallBlock）。后面一出现别的块就不再是 current。
 *
 * index 是段首块在原 blocks 里的下标——既当 v-for 的稳定 key，也让 ChatMessage 能用
 * 原始下标判定流式尾块。
 */
export type Segment =
  | { kind: "block"; block: ContentBlock; index: number }
  | { kind: "narration"; blocks: ToolCallBlock[]; index: number; current: boolean }
  | { kind: "thinking_live"; index: number };

/** 代码变更类工具：头行带 +N −M 与「打开」，预览 / 展开体是 diff。 */
export const CHANGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

export function isChangeTool(name: string): boolean {
  return CHANGE_TOOL_NAMES.has(name);
}

export interface SegmentOptions {
  /** 消息已定稿（不再流式）。 */
  finalized?: boolean;
  /** 「显示思考过程」开关。缺省 false。 */
  showThinking?: boolean;
}

export function segmentBlocks(blocks: ContentBlock[], opts: SegmentOptions = {}): Segment[] {
  const lastIndex = blocks.length - 1;
  const streaming = !opts.finalized;
  const out: Segment[] = [];
  /** 正在累积的旁白段及其合并键。 */
  let open: { seg: Extract<Segment, { kind: "narration" }>; key: string } | null = null;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === "tool_call") {
      const key = narrationKey(block.name);
      if (open && open.key === key) {
        open.seg.blocks.push(block);
      } else {
        const seg = { kind: "narration" as const, blocks: [block], index, current: false };
        out.push(seg);
        open = { seg, key };
      }
      open.seg.current = index === lastIndex;
      continue;
    }
    if (block.type === "thinking" && !opts.showThinking) {
      // 隐藏的思考：不渲染、不切断合并。只在它正是流式中的最后一块时提示「正在思考…」
      if (streaming && index === lastIndex) out.push({ kind: "thinking_live", index });
      continue;
    }
    open = null;
    out.push({ kind: "block", block, index });
  }
  return out;
}
