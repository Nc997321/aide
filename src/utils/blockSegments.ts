import type { ContentBlock } from "@/types/chat";

/** 正文及引用/系统卡片保留原位；连续工具、助手与思考共用一个过程入口。 */
export type ProcessBlock = Extract<ContentBlock, { type: "tool_call" | "subagent" | "thinking" }>;
export type ProcessBlocks = [ProcessBlock, ...ProcessBlock[]];
export type ProcessSegment = { kind: "process"; blocks: ProcessBlocks; index: number; current: boolean };
export type Segment =
  | { kind: "block"; block: ContentBlock; index: number }
  | ProcessSegment;

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

/** 标题跟随最后一条指令；随后的思考不提前撤掉写入预览。纯思考段取最后一块。 */
export function processHead(blocks: readonly [ProcessBlock, ...ProcessBlock[]]): ProcessBlock {
  return blocks.reduce((head, block) =>
    block.type === "thinking" && head.type !== "thinking" ? head : block,
  );
}

export function segmentBlocks(blocks: readonly ContentBlock[], opts: SegmentOptions = {}): Segment[] {
  const out: Segment[] = [];
  let open: ProcessSegment | null = null;
  let current: ProcessSegment | null = null;
  let hasCommand = false;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === "thinking" && !opts.showThinking && (opts.finalized || index !== blocks.length - 1)) continue;
    if (block.type === "text" && !block.text.trim()) continue;
    if (block.type === "tool_call" || block.type === "subagent" || block.type === "thinking") {
      if (open) open.blocks.push(block);
      else {
        open = { kind: "process", blocks: [block], index, current: false };
        out.push(open);
      }
      if (block.type !== "thinking") { current = open; hasCommand = true; }
      else if (!hasCommand) current = open;
      continue;
    }
    open = null;
    out.push({ kind: "block", block, index });
  }
  if (current) current.current = !opts.finalized;
  return out;
}
