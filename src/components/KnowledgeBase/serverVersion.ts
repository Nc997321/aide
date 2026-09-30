// 服务端版本，以及「要不要催用户升级」的判据。**唯一产地**。
//
// 为什么需要它：知识库服务是**用户自己部署**的，可能停在几个月前那一版；而客户端会用
// 服务端的新接口（网页产物入库、取件地址…）。没有这一层，新版客户端遇上旧服务端的表现是
// 「按钮点了 404」——用户看到的是"坏了"，而不是"该升级了"。这一层把话说清楚。
//
// 版本从 `/api/health` 的 `version` 字段来（0.5.0 起才有这个字段，构建期由镜像标签注入）。

/**
 * 这个客户端要求的最低服务端版本。**加新接口时改它**（客户端与服务端要一起发）。
 */
export const MIN_SERVER_VERSION = "0.5.0";

/**
 * 用户侧的升级命令。**一辈子不变**——交付的 compose 跟的是移动标签 `:stable`，
 * 所以这条命令不随版本号改，提示里可以直接让人复制粘贴跑。
 * 要钉住某一版/回滚时，用户才需要动 `.env` 里的 `KB_IMAGE`（见部署指南）。
 */
export const UPGRADE_COMMAND = "docker compose pull knowledge && docker compose up -d knowledge";

/**
 * 服务端报的版本够不够用。
 *
 * 三档，每一档的判据都要说清楚：
 *   - **没报版本**（`undefined`/空）→ 旧。0.5.0 之前的服务端根本没有这个字段，
 *     而"没有字段"正是最需要提示的那一档。
 *   - `dev` / 认不出的号 → **不催**。本地 `up -d --build` 出来的开发构建会报 `dev`；
 *     认不出的号宁缺毋滥，不拿它去吓用户。
 *   - 有版本 → 比大小。
 */
export function needsUpgrade(serverVersion: string | null | undefined): boolean {
  if (!serverVersion) return true;
  if (serverVersion === "dev") return false;
  if (!/^\d+\.\d+/.test(serverVersion)) return false;
  return compareVersions(serverVersion, MIN_SERVER_VERSION) < 0;
}

/** 逐段数字比较；缺位当 0（`0.5` == `0.5.0`）。返回 -1 / 0 / 1，不抛。 */
export function compareVersions(a: string, b: string): number {
  const seg = (v: string): number[] => v.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const left = seg(a);
  const right = seg(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
