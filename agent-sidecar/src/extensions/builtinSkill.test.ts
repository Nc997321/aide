import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureBuiltinSkill, builtinSkillPath, BUILTIN_MARKER } from "./builtinSkill.js";
import { ensureBrowserSkill, browserSkillDir } from "./browserSkill.js";

describe("builtinSkill 内置标记", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "builtin-skill-"));
    env = { CLAUDE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("落地时打内置标记（Host 技能列表据此标只读）", () => {
    ensureBuiltinSkill(env, "demo", "---\nname: demo\n---\n");
    const skillDir = path.dirname(builtinSkillPath(env, "demo"));
    expect(existsSync(path.join(skillDir, BUILTIN_MARKER))).toBe(true);
  });

  it("清掉旧版禁用留下的 SKILL.md.disabled", () => {
    const skillDir = path.dirname(builtinSkillPath(env, "demo"));
    ensureBuiltinSkill(env, "demo", "x");
    writeFileSync(path.join(skillDir, "SKILL.md.disabled"), "old");
    ensureBuiltinSkill(env, "demo", "x");
    expect(existsSync(path.join(skillDir, "SKILL.md.disabled"))).toBe(false);
  });

  it("browser-inspect 也打标记", () => {
    ensureBrowserSkill(env);
    expect(existsSync(path.join(browserSkillDir(env), BUILTIN_MARKER))).toBe(true);
  });
});
