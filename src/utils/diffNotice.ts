import type { DiffPair } from "../types";

/**
 * diff 视图的「不画内容、只给一句话」判定：仅行尾不同 / 二进制 / 太大。
 *
 * 变更卡（静态 diff）与文件查看器（CodeMirror diff）共用这一条——同一份 pair
 * 在两地必须给同一个结论，否则同一处改动换个地方看就换了说法。
 * 返回 null = 正常渲染。
 */

/** 对齐 useFileViewer 的 MAX_EDITABLE_SIZE：防 diff 计算卡窗。 */
export const MAX_DIFF_SIZE = 1_000_000;

export function diffNotice(pair: DiffPair): string | null {
  if (pair.eolOnly) return `内容与 ${pair.oldLabel} 无差异（仅行尾不同）`;
  if (pair.isBinary) return "二进制文件无法对比";
  if (pair.tooBig || pair.oldText.length > MAX_DIFF_SIZE || pair.newText.length > MAX_DIFF_SIZE) {
    return "文件过大（超过 1MB），无法渲染对比视图";
  }
  return null;
}
