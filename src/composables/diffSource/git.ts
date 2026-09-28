/** 适配器：git。同一个机制、只差"跟哪个提交比"：有基线用 `Since`，无基线/降级用 `Unstaged`。 */
import { api } from "../../api";
import type { DiffContentSource, DiffRequest, DiffScope } from "../diffSource";

export const gitSource: DiffContentSource = {
  id: "git",
  available: () => true, // 链尾兜底：永远能服务
  build: async (req) => {
    const mode = req.baseRev
      ? { kind: "since" as const, rev: req.baseRev }
      : { kind: "unstaged" as const };
    const pair = await api.gitDiffPair(req.row.path, { mode, cwd: req.workspaceRoot });
    if (!req.baseRev) return { parts: [{ pair }], note: HEAD_NOTE };
    if (pair.baseMissing) {
      return { parts: [{ pair }], note: `基线 ${short(req.baseRev)} 已不在仓库中，退回 HEAD 累计` };
    }
    return { parts: [{ pair }], note: scopeNote(req.scope, pair.oldLabel) };
  },
};

/** 今天的句子，一字不改（兜底路径仍要说清"这不是本轮片段"）。 */
const HEAD_NOTE = "累计视图：显示该文件相对 HEAD 的全部差异（非本轮片段）";

function scopeNote(scope: DiffScope, shortRev: string): string {
  return scope === "round"
    ? `自开轮时的 ${shortRev} 到工作区（本轮视图）`
    : `自会话起点的 ${shortRev} 到工作区（会话视图）`;
}

/** 降级 note 用的短号：那个 rev 已不在仓库里，Rust 给不出标签，只能在这里截。 */
function short(rev: string): string {
  return rev.slice(0, 7);
}
