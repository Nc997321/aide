import { useFileViewer } from "./useFileViewer";
import { resolveDiff, type DiffScope } from "./diffSource";
import { resolveFileLinkPath } from "@aide/sdk/utils/fileLink";
import type { TouchedFile } from "../types";

/**
 * 「点变更条目 → 弹 diff 窗口」的唯一入口。**取哪份内容交给端口**（见 diffSource.ts）。
 *
 * 窗口要用**绝对路径**：文件树定位、打开真实文件、标题栏展示都建立在绝对路径约定上
 * （git 命令吃的仓库相对路径到端口为止，不外泄给窗口层）。
 */
export interface DiffOpenOptions {
  /** 看哪个口径的"改前"——**由调用点显式声明**，不由数据形状推断 */
  scope: DiffScope;
  /** 会话所属工作区根 */
  workspaceRoot?: string;
  /** 该口径的基线提交（轮首 / 会话首）；缺失 = 无基线 */
  baseRev?: string;
}

export function useDiffWindow() {
  const viewer = useFileViewer();

  /** 打开某条变更记录的 diff 窗口。失败向上抛（调用方给用户反馈），不静默。 */
  async function openDiff(row: TouchedFile, opts: DiffOpenOptions): Promise<void> {
    const diff = await resolveDiff({ row, ...opts });
    await viewer.open(resolveFileLinkPath(row.path, opts.workspaceRoot), { diff });
  }

  return { openDiff };
}
