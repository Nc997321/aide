/**
 * 「一条变更记录的改前/改后从哪里取」——端口（照 `api.ts + api/*` 的分层范式：
 * 组织文件在上层、子实现同名子目录）。
 *
 * 为什么是端口：来源**已经有三个**（本轮内存片段 / 某个提交 / HEAD），而选源原先写在两处
 * ——树行靠 `asTouchedFile()` 掏空片段来"伪造"累计口径，`useDiffWindow` 再按空数组嗅探一次。
 * 口径必须由**消费者显式声明**（`scope`），选择只发生在这里；加来源 = 加一个适配器 + 链上一行。
 */
import type { ChangeRound, TouchedFile } from "../types";
import type { WindowDiff } from "./useFileViewer";
import { segmentsSource } from "./diffSource/segments";
import { gitSource } from "./diffSource/git";

/** 看哪个口径的"改前"。 */
export type DiffScope = "round" | "session";

export interface DiffRequest {
  row: TouchedFile;
  scope: DiffScope;
  /** 会话所属工作区根（git cwd） */
  workspaceRoot?: string;
  /** 该口径的基线提交（轮首 / 会话首）；缺失 = 无基线，走兜底 */
  baseRev?: string;
}

export interface DiffContentSource {
  id: "segments" | "git";
  /** 能不能服务这个请求（纯判定，不取数） */
  available(req: DiffRequest): boolean;
  build(req: DiffRequest): Promise<WindowDiff>;
}

/** 有序链：加来源 = 加一个适配器 + 这里一行。链尾 `gitSource` 恒可服务（兜底）。 */
const CHAIN: DiffContentSource[] = [segmentsSource, gitSource];

export async function resolveDiff(req: DiffRequest): Promise<WindowDiff> {
  const source = CHAIN.find((s) => s.available(req));
  if (!source) throw new Error("no diff source available"); // 链尾恒真，防御
  return source.build(req);
}

/** 会话起点 = 本会话第一个带基线的轮的那个提交（轮首即开轮时刻，故首轮有基线时它就是会话起点）。
 *  只看传进来的这一份 rounds —— 跨会话不串。 */
export function sessionBaseRev(rounds: ChangeRound[]): string | undefined {
  return rounds.find((r) => !!r.baseRev)?.baseRev;
}
