import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeLegacyCodegraphSkill } from "./legacySkills.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "aide-legacy-skill-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function skillFile() {
  return path.join(dir, "skills", "codegraph-explore", "SKILL.md");
}
function put(content: string) {
  mkdirSync(path.dirname(skillFile()), { recursive: true });
  writeFileSync(skillFile(), content, "utf8");
}

describe("removeLegacyCodegraphSkill", () => {
  it("删除我们当年写下的那份（含标记串），空目录一并收掉", () => {
    put("---\nname: codegraph-explore\n---\nThe aide-codegraph MCP tools answer ...");
    removeLegacyCodegraphSkill({ CLAUDE_CONFIG_DIR: dir });
    expect(existsSync(skillFile())).toBe(false);
    expect(existsSync(path.dirname(skillFile()))).toBe(false);
  });

  it("用户自己建的同名 skill（没有标记串）不碰", () => {
    put("---\nname: codegraph-explore\n---\nmy own notes");
    removeLegacyCodegraphSkill({ CLAUDE_CONFIG_DIR: dir });
    expect(existsSync(skillFile())).toBe(true);
  });

  it("干净机器上什么都不发生、不抛错", () => {
    expect(() => removeLegacyCodegraphSkill({ CLAUDE_CONFIG_DIR: dir })).not.toThrow();
  });
});
