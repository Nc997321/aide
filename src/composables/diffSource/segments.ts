/** 适配器：本轮内存片段（精确到片，与 HEAD 无关）。 */
import type { DiffPair, TouchedFile } from "../../types";
import type { WindowDiff } from "../useFileViewer";
import type { DiffContentSource, DiffRequest } from "../diffSource";
import { locateEditStartLine, makePair } from "../../utils/changeCard";
import { resolveFileLinkPath } from "@aide/sdk/utils/fileLink";

export const segmentsSource: DiffContentSource = {
  id: "segments",
  // 口径优先：session 口径即便内存里有片段也不要（那是跨轮视图）
  available: (req) => req.scope === "round" && req.row.segments.length > 0,
  build: async (req) => ({ parts: await segmentParts(req) }),
};

/** 逐段转 pair：片段带 `newText` 在文件中的真实起始行，行号才对得上文件。 */
async function segmentParts(req: DiffRequest): Promise<WindowDiff["parts"]> {
  const absPath = resolveFileLinkPath(req.row.path, req.workspaceRoot);
  const status = pairStatusOf(req.row.status);
  return Promise.all(
    req.row.segments.map(async (seg) => {
      const pair = makePair(seg.oldText, seg.newText, status);
      return { pair, firstLine: await locateEditStartLine(absPath, seg.newText, pair.status) };
    }),
  );
}

/** 变更状态字母（git 口径）→ DiffPair 状态：新增走「新增」配色，其余按修改。 */
function pairStatusOf(status: string): DiffPair["status"] {
  return status === "A" ? "added" : "modified";
}
