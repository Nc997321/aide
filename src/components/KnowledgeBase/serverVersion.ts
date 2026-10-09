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

/** 官方发布仓库（与服务端 config.rs 的 DEFAULT_RELEASE_REPO 同值）。服务端没告诉我们
 *  仓库地址时（老服务端没有 /api/update/status）用它。 */
export const DEFAULT_RELEASE_REPO =
  "registry.example.com/aide/aide-knowledge";

/**
 * 用户侧的升级命令：**把目标镜像写进 `.env` 再拉起**，在部署目录（放 docker-compose.yml
 * 的地方）里跑。
 *
 * 为什么不能只是 `docker compose pull knowledge && docker compose up -d knowledge`：
 *   - 2026-09-30 之前交付的 compose，镜像默认值**本身钉着版本号**（`${KB_IMAGE:-…:0.4.0}`）
 *   - 更早的部署说明让用户在 `.env` 里写 `KB_IMAGE=…:旧版本`
 * 这两种部署跑那条「固定命令」只会把旧版本重拉一遍。写进 `.env` 能同时压住两者
 *（compose 里 `.env` 的值优先于文件里的默认值）。
 *
 * 为什么写进 `.env` 而不是只在命令行里临时指定：那样下一次有人随手 `docker compose up -d`
 * 就会按旧值把服务**降回去**，而数据库迁移不可逆。
 *
 * `tag` 给具体版本号（服务端查到了最新版）；查不到时给 `stable`（移动标签，始终指向最新）。
 */
export function upgradeCommand(repo: string, tag: string): string {
  // 不用 `sed -i`：GNU 与 BSD（macOS 上的 Docker Desktop）语法不同。写回用 `cat >`
  // 而不是 `mv`：保留 .env 原来的权限（里面有数据库口令）。
  return (
    "touch .env && { grep -v '^KB_IMAGE=' .env || true; } > .env.kbnew" +
    ` && printf '\\nKB_IMAGE=%s\\n' '${repo}:${tag}' >> .env.kbnew` +
    " && cat .env.kbnew > .env && rm .env.kbnew" +
    " && docker compose pull knowledge && docker compose up -d knowledge"
  );
}

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
