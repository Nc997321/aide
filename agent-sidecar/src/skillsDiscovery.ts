// 受信任工作区（受限模式）支持：识别项目级 .aide/claude/skills/ 里的 skill 名字，
// 供 session-worker 经 SDK options.managedSettings.skillOverrides 把它们从
// 模型的 skill 列表与 Skill 工具中隐藏（值 "off"）。这样不信任工作区不会自动
// 加载项目 skill，而 user / plugin skill 不受影响（skills 仍为 "all"）。
//
// 与 src-tauri/src/skills.rs 的 scan_dir / parse_frontmatter 同思路，但只扫
// 项目源、只取名字、纯同步（目录小、仅会话启动时一次）。永不抛——调用方
// startLoop 不能被 skill 扫描阻塞。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 扫 {cwd}/.aide/claude/skills/<name>/SKILL.md，返回 `{ [skillName]: "off" }` 覆盖表。
 *  目录不存在 / 无 SKILL.md / 解析失败时静默跳过，永不抛。 */
export function buildProjectSkillOverrides(cwd: string): Record<string, "off"> {
  const overrides: Record<string, "off"> = {};
  const dir = join(cwd, ".aide", "claude", "skills");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return overrides; // 不存在或不可读 → 无项目 skill
  }
  for (const name of entries) {
    const skillMd = join(dir, name, "SKILL.md");
    if (!existsSync(skillMd)) continue; // 非目录或无 SKILL.md → 跳过
    const skillName = readSkillName(skillMd) ?? name;
    overrides[skillName] = "off";
  }
  return overrides;
}

/** 读 SKILL.md frontmatter 的 name: 字段；失败返回 null（调用方回落目录名）。 */
function readSkillName(skillMdPath: string): string | null {
  let content: string;
  try {
    content = readFileSync(skillMdPath, "utf8");
  } catch {
    return null;
  }
  return parseFrontmatterName(content);
}

/** 解析 SKILL.md YAML frontmatter 的 name: 字段（与 skills.rs parse_frontmatter
 *  同思路）：frontmatter 以 `---` 开头、`\n---` 结束；name 值去引号/空白。
 *  导出供单测直接覆盖。 */
export function parseFrontmatterName(content: string): string | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const after = trimmed.slice(3);
  const end = after.indexOf("\n---");
  if (end < 0) return null;
  const fm = after.slice(0, end);
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^\s*name:\s*(.+?)\s*$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}