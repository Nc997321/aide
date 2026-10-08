import { readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toForwardSlashes, safeDirname } from "../engine/winPaths.js";

/**
 * 清理已退役的内建 skill 落地文件。
 *
 * codegraph（代码索引）已于 2026-10-01 移除，它的内建 skill `codegraph-explore` 此前由 sidecar
 * 启动时写进 `$CLAUDE_CONFIG_DIR/skills/`。老机器上那份文件还在，会让模型被「先调 aide-codegraph
 * 工具」的指令引到一个不存在的工具上——所以启动时认出**我们自己写的那份**（正文里有
 * 标记串）就删掉；用户自己建的同名 skill（没有标记）不碰。失败静默，不阻塞会话启动。
 */

type Env = Record<string, string | undefined>;

const LEGACY_MARKER = "aide-codegraph MCP tools";

export function removeLegacyCodegraphSkill(env: Env): void {
  try {
    const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".aide", "claude");
    const file = toForwardSlashes(
      path.join(toForwardSlashes(dir), "skills", "codegraph-explore", "SKILL.md"),
    );
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return; // 不存在：干净机器
    }
    if (!content.includes(LEGACY_MARKER)) return; // 用户自己的同名 skill
    rmSync(file, { force: true });
    const skillDir = safeDirname(file);
    if (readdirSync(skillDir).length === 0) rmdirSync(skillDir);
  } catch {
    /* 配置目录不可写等：跳过 */
  }
}
