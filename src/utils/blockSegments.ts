import type { ContentBlock } from "@/types/chat";

/** 正文、代码变更及引用/系统卡片保留原位；其余连续过程共用一个入口。 */
export type ProcessBlock = Extract<ContentBlock, { type: "tool_call" | "subagent" | "thinking" }>;
export type ProcessBlocks = [ProcessBlock, ...ProcessBlock[]];
export type ProcessSegment = { kind: "process"; blocks: ProcessBlocks; index: number; current: boolean };
export type Segment =
  | { kind: "block"; block: ContentBlock; index: number }
  | ProcessSegment;

/** 代码变更类工具：在对话中原位显示 diff。 */
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
    // 「不显示思考过程」= 思考块彻底不渲染——流式中也不留「正在思考…」占位行。
    // 状态感知归输入框上方的状态条（推敲中·计时·中断）。2026-11-24 用户拍板去掉
    // "放行流式尾块"例外；下方 segment 里 thinking 只可能出现在 showThinking=true 时，
    // 渲染层（ProcessGroup/ThinkingBlock）无需再对思考做二次隐藏。
    if (block.type === "thinking" && !opts.showThinking) continue;
    if (block.type === "text" && !block.text.trim()) continue;
    if (block.type === "tool_call" && isChangeTool(block.name)) {
      open = null;
      current = null;
      hasCommand = true;
      out.push({ kind: "block", block, index });
      continue;
    }
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
