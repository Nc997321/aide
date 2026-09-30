import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAideInstructions, type InstructionSources } from "./instructions.js";
import { pathToKey } from "./memoryDirs.js";

describe("loadAideInstructions", () => {
  let root: string;
  let claudeDir: string;
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aide-instructions-"));
    claudeDir = join(root, "claude");
    cwd = join(root, "proj");
    await mkdir(claudeDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 默认主根信任、无附加根；各用例只覆盖自己那一维。 */
  function load(over: Partial<InstructionSources> = {}) {
    return loadAideInstructions({ cwd, configDir: claudeDir, trusted: true, ...over });
  }

  it("远程车道：全局 CLAUDE.md 读桌面镜像（userDir），不读目标机 configDir", async () => {
    await writeFile(join(claudeDir, "CLAUDE.md"), "target-local rules");
    const mirror = join(root, "mirror");
    await mkdir(mirror, { recursive: true });
    await writeFile(join(mirror, "CLAUDE.md"), "desktop rules");
    const text = await load({ userDir: mirror });
    expect(text).toContain("desktop rules");
    expect(text).not.toContain("target-local rules");
  });

  /** 造一个附加根 `<root>/<name>`；给了 memory 就顺带在 projects 下造出索引
   *  （目录名与 memoryDirs 的 key 规则一致）。 */
  async function attachedRoot(name: string, files: { rules?: string; memory?: string } = {}) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    if (files.rules !== undefined) await writeFile(join(dir, "CLAUDE.md"), files.rules);
    if (files.memory !== undefined) {
      const memDir = join(claudeDir, "projects", pathToKey(dir).replace(/\./g, "-"), "memory");
      await mkdir(memDir, { recursive: true });
      await writeFile(join(memDir, "MEMORY.md"), files.memory);
    }
    return dir;
  }

  it("concatenates global and project CLAUDE.md with a blank line", async () => {
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");
    await writeFile(join(cwd, "CLAUDE.md"), "PROJECT");

    const text = await load();
    expect(text).toBe("GLOBAL\n\nPROJECT");
  });

  it("skips a missing project file silently (no diagnostic, no throw)", async () => {
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");

    const text = await load();
    expect(text).toBe("GLOBAL");
  });

  it("trusted=false（受限模式）→ 只读全局，主根 CLAUDE.md 跳过", async () => {
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");
    await writeFile(join(cwd, "CLAUDE.md"), "PROJECT");

    expect(await load({ trusted: false })).toBe("GLOBAL");
  });

  it("returns empty string when neither file exists", async () => {
    const text = await loadAideInstructions({
      cwd: join(root, "nope1"),
      configDir: join(root, "nope2"),
      trusted: true,
    });
    expect(text).toBe("");
  });

  it("replaces an oversize file with a diagnostics line instead of loading it", async () => {
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");
    // 256 KiB + 1 byte over the cap.
    const oversize = "x".repeat(256 * 1024 + 1);
    await writeFile(join(cwd, "CLAUDE.md"), oversize);

    const text = await load();
    expect(text).toContain("GLOBAL");
    expect(text).not.toContain(oversize);
    expect(text).toMatch(/超过 256 KiB/);
  });

  it("never reads .claude/settings.json", async () => {
    await mkdir(join(claudeDir, ".claude"), { recursive: true });
    await writeFile(join(claudeDir, ".claude", "settings.json"), '{"secret":"leak"}');
    await writeFile(join(claudeDir, "CLAUDE.md"), "GLOBAL");

    const text = await load();
    expect(text).toBe("GLOBAL");
    expect(text).not.toContain("leak");
  });

  it("never throws on an unreadable file (returns a diagnostics line)", async () => {
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
    const text = await load();
    expect(typeof text).toBe("string");
  });

  describe("附加工作区（@目录，D8：@ 即信任）", () => {
    it("本仓 CLAUDE.md 带来源头注入——trusted=false 也注入", async () => {
      const b = await attachedRoot("repoB", { rules: "B-RULES" });

      const text = await load({ trusted: false, attached: [b] });
      expect(text).toContain(`--- 附加工作区指令：${b} ---`);
      expect(text).toContain("仅当操作该仓库的文件时适用");
      expect(text).toContain("B-RULES");
    });

    it("auto memory 索引从 projects/<key>/memory/MEMORY.md 取", async () => {
      const b = await attachedRoot("repoB", { memory: "# Memory\n- [一](a.md) — 描述" });

      const text = await load({ attached: [b] });
      expect(text).toContain("[一](a.md)");
    });

    it("既无 CLAUDE.md 也无记忆 → 整块不出现（不留空来源头）", async () => {
      const c = await attachedRoot("repoC");

      expect(await load({ attached: [c] })).not.toContain("附加工作区指令");
    });

    it("记忆索引截断：前 200 行（第 201 行起丢掉）", async () => {
      const lines = Array.from({ length: 260 }, (_, i) => `- line-${i}`).join("\n");
      const d = await attachedRoot("repoD", { memory: lines });

      const text = await load({ attached: [d] });
      expect(text).toContain("- line-199");
      expect(text).not.toContain("- line-200");
      expect(text).toContain("记忆索引过长，已截断");
    });

    it("记忆索引截断：单行超 25 KiB 按字节切", async () => {
      const d = await attachedRoot("repoE", { memory: "y".repeat(26 * 1024) });

      const text = await load({ attached: [d] });
      expect(text).toContain("记忆索引过长，已截断");
      expect(Buffer.byteLength(text, "utf8")).toBeLessThan(26 * 1024);
    });

    it("超过 8 个根上限的部分不注入，并留一行诊断", async () => {
      const dirs: string[] = [];
      for (let i = 0; i < 9; i++) dirs.push(await attachedRoot(`repo-${i}`, { rules: `RULES-${i}` }));

      const text = await load({ attached: dirs });
      expect(text).toContain("RULES-7");
      expect(text).not.toContain("RULES-8");
      expect(text).toContain("超过 8 个上限");
    });

    it("超过 512 KiB 总预算的块整块跳过，并留一行诊断", async () => {
      const big = "x".repeat(200 * 1024);
      const dirs = [
        await attachedRoot("bigA", { rules: big }),
        await attachedRoot("bigB", { rules: big }),
        await attachedRoot("bigC", { rules: big }),
      ];

      const text = await load({ attached: dirs });
      expect(text.split("--- 附加工作区指令：")).toHaveLength(3); // 只进了两块
      expect(text).toContain("超过 524288 字节上限");
    });
  });
});
