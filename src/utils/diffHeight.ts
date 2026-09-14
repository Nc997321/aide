import type { DiffPair } from "../types";

/**
 * DiffViewer 容器高度估算：DiffViewer 内部是 100% 布局，外层容器必须定高。
 * 按片段行数估、超高封顶内滚。对话变更卡与文件窗 diff 面板共用同一套估算——
 * 同一段 diff 在两处显高一致，不出现「同一个改动换个地方看就换了个高度」。
 */
export function estimateDiffHeight(pair: DiffPair, fontSize: number): number {
  const lines = Math.max(pair.oldText.split("\n").length, pair.newText.split("\n").length, 1);
  const TOOLBAR = 38;
  const perLine = Math.round(fontSize * 1.6);
  return Math.min(480, Math.max(120, TOOLBAR + lines * perLine + 16));
}
