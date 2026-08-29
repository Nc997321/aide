export interface SkillMeta {
  name: string;
  description: string;
  /** "user" | "project" | "plugin:superpowers" */
  source: string;
  /** SKILL.md 绝对路径 */
  filePath: string;
  /** "claude" | future: "codex" | "opencode" */
  provider: string;
}
