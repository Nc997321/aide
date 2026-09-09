import type { ChangeFile, ChangeRound } from "../types";

/**
 * 全会话累计文件清单（顶部统一树的输入，D2 = 本会话累计）。
 *
 * 跨轮同路径合并：行数累加，**status 取最新一轮的**（正序遍历，后者覆盖前者）——
 * 一个文件先被 Write 建（A）、后被 Edit 改（M），累计视图该显示 M。
 *
 * 输入是 `ChangeFile`（落盘投影）而非 `TouchedFile`：历史轮从磁盘加载只有 files，
 * 用 touches 会让「历史轮」与「本轮」走两条路。这里只需要路径/状态/行数。
 *
 * 放在 utils 而不是归集器里：它是**展示侧聚合**（谁都能拿 rounds 算），不依赖
 * 事件流；面板从 composable 导入值会让「UI → 状态层」的依赖方向反过来。
 */
export function mergeChangeFiles(rounds: ChangeRound[]): ChangeFile[] {
  const merged = new Map<string, ChangeFile>();
  for (const r of rounds) {
    for (const f of r.files) {
      const cur = merged.get(f.path);
      if (!cur) {
        merged.set(f.path, { ...f });
        continue;
      }
      cur.additions += f.additions;
      cur.deletions += f.deletions;
      cur.status = f.status;
    }
  }
  return [...merged.values()];
}
