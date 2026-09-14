import { api } from "../api";
import { useFileViewer, type WindowDiff } from "./useFileViewer";
import { locateEditStartLine, makePair } from "../utils/changeCard";
import { resolveFileLinkPath } from "@aide/sdk/utils/fileLink";
import type { DiffPair, TouchedFile } from "../types";

/**
 * 「点变更条目 → 弹 diff 窗口」的唯一入口。
 *
 * 窗口内容按**本轮片段**是否还在内存分两态（同一套 DiffViewer，不维护第二套渲染）：
 * - 有片段 → 本轮精确 diff，逐段渲染并标真实起始行；
 * - 无片段（历史轮 / 重启后 / 本轮没被事件记录）→ git 累计视图（HEAD → 当前）+ 标注，
 *   不假装它是本轮的。
 *
 * 窗口要用**绝对路径**：文件树定位、打开真实文件、标题栏展示都建立在绝对路径约定上
 * （git 命令吃的仓库相对路径到这里为止，不外泄给窗口层）。
 */
export function useDiffWindow() {
  const viewer = useFileViewer();

  /** 打开某条变更记录的 diff 窗口。失败向上抛（调用方给用户反馈），不静默。 */
  async function openDiff(row: TouchedFile, wsRoot: string | undefined): Promise<void> {
    const absPath = resolveFileLinkPath(row.path, wsRoot);
    await viewer.open(absPath, { diff: await buildDiff(row, wsRoot) });
  }

  return { openDiff };
}

/** 有片段 → 片段视图；没有 → 累计视图。 */
async function buildDiff(row: TouchedFile, wsRoot: string | undefined): Promise<WindowDiff> {
  if (row.segments.length === 0) return cumulativeDiff(row, wsRoot);
  return { parts: await segmentParts(row, wsRoot) };
}

/** 逐段转 pair：片段带 `newText` 在文件中的真实起始行，行号才对得上文件。 */
async function segmentParts(row: TouchedFile, wsRoot: string | undefined): Promise<WindowDiff["parts"]> {
  const absPath = resolveFileLinkPath(row.path, wsRoot);
  const status = pairStatusOf(row.status);
  return Promise.all(
    row.segments.map(async (seg) => {
      const pair = makePair(seg.oldText, seg.newText, status);
      return { pair, firstLine: await locateEditStartLine(absPath, seg.newText, pair.status) };
    }),
  );
}

async function cumulativeDiff(row: TouchedFile, wsRoot: string | undefined): Promise<WindowDiff> {
  const pair = await api.gitDiffPair(row.path, { cwd: wsRoot });
  return { parts: [{ pair }], note: "累计视图：显示该文件相对 HEAD 的全部差异（非本轮片段）" };
}

/** 变更状态字母（git 口径）→ DiffPair 状态：新增走「新增」配色，其余按修改。 */
function pairStatusOf(status: string): DiffPair["status"] {
  return status === "A" ? "added" : "modified";
}
