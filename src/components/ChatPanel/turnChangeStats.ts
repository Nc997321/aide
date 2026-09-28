/**
 * 回合结算卡的显示量（纯函数，无 Vue 依赖）。
 *
 * 单独成文件的理由：这些是"数字怎么算、怎么写字"的规则——文案与格式是评审过
 * 的（spec §2.5），值得被用例钉住；卡片组件只管摆放。
 */
import type { ChangeFile } from "@/types";

export interface RoundStats {
  files: number;
  additions: number;
  deletions: number;
}

/** 一轮的规模：文件数 + 逐文件累加的行数。
 *  只吃 `files`（落盘投影）不吃 `touches`——历史轮只有前者，两条路会算出两个数。 */
export function roundStats(files: ChangeFile[]): RoundStats {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}

/** 千分位仅在 ≥4 位数字时出现（`+1,240`）。手写而不是 toLocaleString：
 *  后者的分隔符随运行环境 locale 变（德语法语给 `.` / 空格），是"同一份数据两种字"。 */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export type BarSegment = { kind: "add" | "del"; flex: number };

/** 比例条的分段：绿=加、红=删，`flex` 取**原始行数**（比例由 flex 分配表达，
 *  长度恒定）——量级由数字承担，条不表达量级（spec §2.4）。
 *  零值不产生分段：纯新增轮不出现空的红段。 */
export function barSegments(s: RoundStats): BarSegment[] {
  const segs: BarSegment[] = [];
  if (s.additions > 0) segs.push({ kind: "add", flex: s.additions });
  if (s.deletions > 0) segs.push({ kind: "del", flex: s.deletions });
  return segs;
}
