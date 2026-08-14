import type { DiffPair } from "../../types";

/**
 * 全文件 diff 的定位逻辑——git diff 窗「打开文件并定位到首个变更」用。
 * 聊天变更卡不走这里：它的 pair 是片段 diff（old/new 只是新旧片段，
 * 行号相对片段坐标系无意义），那边走 changeCard.locateAnchorLine 的
 * 内容锚点搜索。
 */

/**
 * 新文本中首个变更行的 1-based 行号：逐行扫共同前缀，首个不一致处即目标。
 * 修改/插入落在变更行本身；纯删除落在「删除点后一行」（新文本里该位置
 * 现存的内容）。快照漂移说明：diff 是打开时刻的快照，此后文件又被编辑过
 * 的话行号只是近似——工作区 diff（newText ≈ 当前文件）是精确的。
 */
export function firstChangedLine(pair: DiffPair): number {
  const oldLines = pair.oldText.split("\n");
  const newLines = pair.newText.split("\n");
  const n = Math.min(oldLines.length, newLines.length);
  let i = 0;
  while (i < n && oldLines[i] === newLines[i]) i++;
  return i + 1;
}
