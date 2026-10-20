import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toForwardSlashes, safeDirname } from "../engine/winPaths.js";

/**
 * 内建 skill 的落地（免用户配置）：把一份 SKILL.md 写进会话的配置目录，SDK 自己发现它。
 * 每个内建 skill（aide-app / aide-video / aide-design…）只提供名字与正文，落地走这里。
 *
 * 成本口径：进每个会话上下文的只有 frontmatter 的 description 那一行，正文是模型判定
 * 相关后才按需加载的——所以 description 只写触发条件，方法都放正文。
 */

export type SkillEnv = Record<string, string | undefined>;

export function builtinSkillPath(env: SkillEnv, name: string): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".aide", "claude");
  return path.join(toForwardSlashes(path.join(toForwardSlashes(dir), "skills", name)), "SKILL.md");
}

/**
 * 内置标记文件名。Host 的技能列表（aide-core `customizations/skills.rs`）看到它就标 `source: "builtin"`
 * 并拒绝删除 / 编辑 / 禁用——sidecar 每次启动都会写回内置技能，用户的修改本来就留不住。
 * 两边约定同一个名字，内置名单只在 sidecar 这一处。
 */
export const BUILTIN_MARKER = ".aide-builtin";

/** 给内置技能目录打标记，并清掉旧版允许禁用时留下的 `SKILL.md.disabled`。失败静默。 */
export function markBuiltinSkillDir(dir: string): void {
  try {
    const marker = toForwardSlashes(path.join(dir, BUILTIN_MARKER));
    let has = false;
    try {
      readFileSync(marker, "utf8");
      has = true;
    } catch {
      /* 没有，下面写 */
    }
    if (!has) writeFileSync(marker, "Aide 内置技能：由 sidecar 维护，启动时自动更新。\n", "utf8");
  } catch {
    /* 跳过 */
  }
  try {
    rmSync(toForwardSlashes(path.join(dir, "SKILL.md.disabled")), { force: true });
  } catch {
    /* 跳过 */
  }
}

/** 幂等落地：内容不同才写。任何失败都跳过，不影响会话。 */
export function ensureBuiltinSkill(env: SkillEnv, name: string, content: string): void {
  const file = builtinSkillPath(env, name);
  try {
    // mkdirSync 独立 try：bun 的 recursive mkdir 对已存在目录抛 EEXIST（Node 是 no-op）
    try {
      mkdirSync(safeDirname(file), { recursive: true });
    } catch {
      /* 父目录已存在或不可创建，继续尝试写 */
    }
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* 不存在，下面写 */
    }
    if (current !== content) writeFileSync(file, content, "utf8");
    markBuiltinSkillDir(safeDirname(file));
  } catch {
    /* 配置目录不可写等情况：跳过 */
  }
}
