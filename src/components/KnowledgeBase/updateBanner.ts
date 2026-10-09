// 知识库面板顶部「有新版本」横幅该说什么。**唯一判据产地**，纯函数（可直测）。
//
// 背景：知识库服务装在用户自己的服务器上，以前只有「服务端低于客户端最低要求」时才提示——
// 服务端出了修复版，没人知道。现在服务端会查发布渠道（GET /api/update/status，见
// knowledge-server/src/api/update.rs），有新版就提示并给出升级命令。
// **只告知，不执行**：升级仍是管理员在服务器上跑那条命令。

import type { KbUpdateStatus } from "./kbClient";
import { compareVersions, DEFAULT_RELEASE_REPO, upgradeCommand } from "./serverVersion";

/** 服务端更新状态：拿到了 / 服务端没有这个接口（0.6.0 之前）/ 还没查或查失败。 */
export type UpdateStatusSource = KbUpdateStatus | "unsupported" | null;

export type UpdateBanner =
  | { kind: "none" }
  /**
   * 该升级了。
   * - latest：发布渠道上的最新版本（老服务端查不到时为 null，命令里用 `stable`）
   * - required：低于客户端最低要求（不升有功能用不了），此时不能「以后再说」
   * - isAdmin：只有管理员能升级；普通成员的文案是「请联系管理员」（命令照给——小团队里常是同一个人）
   */
  | {
      kind: "upgrade";
      current: string | null;
      latest: string | null;
      required: boolean;
      isAdmin: boolean;
      command: string;
    };

export interface BannerInput {
  isAdmin: boolean;
  /** /api/health 的 version（null = 老服务端没这个字段） */
  current: string | null;
  /** 低于客户端最低要求（serverVersion.needsUpgrade） */
  needsUpgrade: boolean;
  status: UpdateStatusSource;
  /** 用户对这个版本点过「以后再说」（按版本记：再出新版还会提示） */
  dismissedVersion: string | null;
}

export function decideUpdateBanner(i: BannerInput): UpdateBanner {
  const s = i.status && i.status !== "unsupported" ? i.status : null;
  const repo = s?.repo ?? DEFAULT_RELEASE_REPO;
  const current = s?.current ?? i.current;

  // 发布渠道有比当前新的版本（dev 构建不催——那是本地开发形态）
  const latest = s?.latest ?? null;
  const newer = !!latest && !!current && current !== "dev" && compareVersions(latest, current) > 0;

  if (!newer && !i.needsUpgrade) return { kind: "none" };
  if (newer && !i.needsUpgrade && latest === i.dismissedVersion) return { kind: "none" };

  return {
    kind: "upgrade",
    current,
    latest: newer ? latest : null,
    required: i.needsUpgrade,
    isAdmin: i.isAdmin,
    // 具体版本号：命令升到的就是横幅上说的那版。查不到（老服务端 / 离线）→ stable
    command: upgradeCommand(repo, newer && latest ? latest : "stable"),
  };
}
