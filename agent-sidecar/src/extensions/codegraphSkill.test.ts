import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureCodegraphSkill, skillPath, SKILL_CONTENT } from "./codegraphSkill.js";

describe("codegraphSkill", () => {
  let dir: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cg-skill-"));
    env = { CLAUDE_CONFIG_DIR: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes SKILL.md with frontmatter trigger and workflow rules", () => {
    ensureCodegraphSkill(env);
    const file = skillPath(env);
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    // frontmatter 触发描述必须命中探索类任务关键词
    expect(content).toContain("name: codegraph-explore");
    expect(content).toContain("BEFORE fanning out Grep/Read");
    // 工作流硬约束：三工具 + Read 时机
    expect(content).toContain("mcp__aide-codegraph__find_symbol");
    expect(content).toContain("mcp__aide-codegraph__call_graph");
    expect(content).toContain("mcp__aide-codegraph__semantic_search");
    expect(content).toContain("Read files only AFTER the index");
  });

  it("rewrites when content drifted, keeps file when current", () => {
    ensureCodegraphSkill(env);
    const file = skillPath(env);
    writeFileSync(file, "stale content", "utf8");
    ensureCodegraphSkill(env);
    expect(readFileSync(file, "utf8")).toBe(SKILL_CONTENT);
  });

  it("is a silent no-op when the config dir is unwritable", () => {
    // 指向一个文件而非目录 → mkdirSync 必败，不得抛出
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    expect(() =>
      ensureCodegraphSkill({ CLAUDE_CONFIG_DIR: path.join(blocker, "sub") }),
    ).not.toThrow();
  });
});
