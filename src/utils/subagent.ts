import type { SubagentBlock } from "@/types/chat";

/**
 * 子代理块的派生读数（消息流内联块与子代理 dock 共用一份实现）。
 * 纯函数、不依赖 Vue——两处的状态色/步数永远同源。
 */

/** 运行三态：跑 / 完成 / 出错（左条色、状态胶囊、dock 列表图标都据它取）。 */
export function subagentStatus(block: SubagentBlock): "run" | "done" | "err" {
  if (block.isPending) return "run";
  if (block.isError) return "err";
  return "done";
}

/** 已执行的工具步数——时间线里 type === "tool" 的条目数（思考/文本不算「步」）。 */
export function subagentStepCount(block: SubagentBlock): number {
  return block.entries.filter((e) => e.type === "tool").length;
}
