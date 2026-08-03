import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectSkillOverrides, parseFrontmatterName } from "./skillsDiscovery.js";

describe("buildProjectSkillOverrides", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aide-skills-disc-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty when no .claude/skills dir exists", () => {
    expect(buildProjectSkillOverrides(root)).toEqual({});
  });

  it("collects project skill names using frontmatter name", () => {
    const skillsDir = join(root, ".aide", "claude", "skills");
    mkdirSync(join(skillsDir, "brainstorming"), { recursive: true });
    writeFileSync(
      join(skillsDir, "brainstorming", "SKILL.md"),
      "---\nname: brainstorming\ndescription: \"x\"\n---\nbody",
    );
    mkdirSync(join(skillsDir, "debug-skill"), { recursive: true });
    writeFileSync(
      join(skillsDir, "debug-skill", "SKILL.md"),
      "---\nname: systematic-debugging\ndescription: y\n---\n",
    );

    expect(buildProjectSkillOverrides(root)).toEqual({
      brainstorming: "off",
      "systematic-debugging": "off",
    });
  });

  it("falls back to directory name when SKILL.md has no frontmatter name", () => {
    const skillsDir = join(root, ".aide", "claude", "skills");
    mkdirSync(join(skillsDir, "my-tool"), { recursive: true });
    writeFileSync(join(skillsDir, "my-tool", "SKILL.md"), "# no frontmatter");
    expect(buildProjectSkillOverrides(root)).toEqual({ "my-tool": "off" });
  });

  it("skips entries without SKILL.md (dirs and loose files)", () => {
    const skillsDir = join(root, ".aide", "claude", "skills");
    mkdirSync(join(skillsDir, "has-md"), { recursive: true });
    writeFileSync(join(skillsDir, "has-md", "SKILL.md"), "---\nname: a\n---\n");
    mkdirSync(join(skillsDir, "no-md"), { recursive: true });
    writeFileSync(join(skillsDir, "loose-file.txt"), "ignore me");

    expect(buildProjectSkillOverrides(root)).toEqual({ a: "off" });
  });

  it("strips surrounding quotes from frontmatter name", () => {
    const skillsDir = join(root, ".aide", "claude", "skills");
    mkdirSync(join(skillsDir, "q"), { recursive: true });
    writeFileSync(
      join(skillsDir, "q", "SKILL.md"),
      '---\nname: "quoted-name"\ndescription: "d"\n---\n',
    );
    expect(buildProjectSkillOverrides(root)).toEqual({ "quoted-name": "off" });
  });
});

describe("parseFrontmatterName", () => {
  it("parses name field", () => {
    expect(parseFrontmatterName("---\nname: foo\ndescription: bar\n---\n# body")).toBe("foo");
  });
  it("returns null without frontmatter", () => {
    expect(parseFrontmatterName("# no fm")).toBeNull();
  });
  it("returns null when frontmatter has no name", () => {
    expect(parseFrontmatterName("---\ndescription: bar\n---\n")).toBeNull();
  });
  it("handles single-quoted name", () => {
    expect(parseFrontmatterName("---\nname: 'q'\n---\n")).toBe("q");
  });
  it("handles double-quoted name", () => {
    expect(parseFrontmatterName('---\nname: "q"\n---\n')).toBe("q");
  });
});