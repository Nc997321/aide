import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMPUTER_SKILL_CONTENT, computerSkillPath, ensureComputerSkill } from "./computerSkill.js";

describe("computerSkill", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "computer-skill-"));
    env = { CLAUDE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("落地 SKILL.md", () => {
    ensureComputerSkill(env);
    const file = computerSkillPath(env);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").startsWith("---\nname: computer-use\n")).toBe(true);
  });

  it("描述行保持短：它进每个会话的上下文", () => {
    const description = COMPUTER_SKILL_CONTENT.split("\n")[2]!;
    expect(description.startsWith("description: ")).toBe(true);
    expect(description.length).toBeLessThan(400);
  });

  it("不出现任何应用名词（不为特定场景打补丁）", () => {
    const lower = COMPUTER_SKILL_CONTENT.toLowerCase();
    for (const app of [
      "qq", "wechat", "微信", "notepad", "记事本", "excel", "word", "powerpoint", "outlook",
      "chrome", "edge", "firefox", "explorer", "资源管理器", "powershell", "cmd.exe", "windows terminal",
      "claude", "vs code", "vscode", "slack", "teams", "telegram", "dingtalk", "钉钉", "飞书",
    ]) {
      expect(lower.includes(app), app).toBe(false);
    }
  });

  it("写明核心纪律：小批量、看回报、不可逆操作单独一步并事后核对、接管即停", () => {
    expect(COMPUTER_SKILL_CONTENT).toContain("small batches");
    expect(COMPUTER_SKILL_CONTENT).toContain("of its own");
    expect(COMPUTER_SKILL_CONTENT).toContain("never repeat it blindly");
    expect(COMPUTER_SKILL_CONTENT).toContain("took over");
    expect(COMPUTER_SKILL_CONTENT).toContain("scope");
  });
});
