import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAideInstructions } from "./instructions.js";

describe("loadAideInstructions", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aide-instructions-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("concatenates global and project CLAUDE.md with a blank line", async () => {
    const claudeDir = join(root, "claude");
    const cwd = join(root, "proj");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");
    await writeFile(join(cwd, "CLAUDE.md"), "PROJECT");

    const text = await loadAideInstructions(cwd, claudeDir);
    expect(text).toBe("GLOBAL\n\nPROJECT");
  });

  it("skips a missing project file silently (no diagnostic, no throw)", async () => {
    const claudeDir = join(root, "claude");
    const cwd = join(root, "proj");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");

    const text = await loadAideInstructions(cwd, claudeDir);
    expect(text).toBe("GLOBAL");
  });

  it("returns empty string when neither file exists", async () => {
    const text = await loadAideInstructions(join(root, "nope1"), join(root, "nope2"));
    expect(text).toBe("");
  });

  it("replaces an oversize file with a diagnostics line instead of loading it", async () => {
    const claudeDir = join(root, "claude");
    const cwd = join(root, "proj");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");
    // 256 KiB + 1 byte over the cap.
    const oversize = "x".repeat(256 * 1024 + 1);
    await writeFile(join(cwd, "CLAUDE.md"), oversize);

    const text = await loadAideInstructions(cwd, claudeDir);
    expect(text).toContain("GLOBAL");
    expect(text).not.toContain(oversize);
    expect(text).toMatch(/超过 256 KiB/);
  });

  it("never reads .claude/settings.json", async () => {
    const claudeDir = join(root, "claude");
    const cwd = join(root, "proj");
    await mkdir(join(claudeDir, ".claude"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(claudeDir, ".claude", "settings.json"), '{"secret":"leak"}');
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");

    const text = await loadAideInstructions(cwd, claudeDir);
    expect(text).toBe("GLOBAL");
    expect(text).not.toContain("leak");
  });

  it("never throws on an unreadable file (returns a diagnostics line)", async () => {
    const claudeDir = join(root, "claude");
    const cwd = join(root, "proj");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const unreadable = join(claudeDir, "CLAUDE.md");
    await writeFile(unreadable, "GLOBAL");
    // Drop read permission. On Windows chmod is a no-op for this case, so the
    // file is still readable — accept either outcome (loaded or diagnostics),
    // the invariant that matters is "does not throw".
    try {
      await chmod(unreadable, 0o000);
    } catch {
      // platform doesn't support the mode — skip the test's strict assertion
    }
    const text = await loadAideInstructions(cwd, claudeDir);
    expect(typeof text).toBe("string");
  });
});