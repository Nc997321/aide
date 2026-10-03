// 跨工作区记忆（只读）：授权边界是**构造性**的——这里钉的是「不在 roots 里读不到」
// 「没有路径逃逸」「中途加根立即生效」，而不是提示词。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { crossMemoryMcpRegistration, readCrossMemory, MEMORY_READ_RULES } from "./crossMemory.js";
import { pathToKey } from "./memoryDirs.js";

let base: string;
let configDir: string;
let repoB: string;
let repoC: string;

function memDirOf(dir: string): string {
  return path.join(configDir, "projects", pathToKey(dir).replace(/\./g, "-"), "memory");
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "aide-xmem-"));
  configDir = path.join(base, "claude");
  repoB = path.join(base, "repoB");
  repoC = path.join(base, "repoC");
  mkdirSync(memDirOf(repoB), { recursive: true });
  writeFileSync(path.join(memDirOf(repoB), "MEMORY.md"), "- [风格](style.md) — 写作口吻\n");
  writeFileSync(path.join(memDirOf(repoB), "style.md"), "少用书面语，句子短。");
  // 同一份文件系统里的另一个工作区：有记忆，但**不在** roots 里
  mkdirSync(memDirOf(repoC), { recursive: true });
  writeFileSync(path.join(memDirOf(repoC), "secret.md"), "C 仓的内部信息");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("readCrossMemory", () => {
  it("不带 id：返回索引 + 条目文件名（不含 MEMORY.md 自己）", async () => {
    const out = await readCrossMemory({ configDir, roots: () => [repoB] }, repoB);
    expect(out).toContain("写作口吻");
    expect(out).toContain("- style.md");
    expect(out).not.toContain("- MEMORY.md");
  });

  it("带 id：返回该条正文", async () => {
    const out = await readCrossMemory({ configDir, roots: () => [repoB] }, repoB, "style.md");
    expect(out).toContain("少用书面语，句子短。");
  });

  it("root 不在授权里 → 拒绝，且文本里列出当前可参考的根（不泄露对方记忆）", async () => {
    const out = await readCrossMemory({ configDir, roots: () => [repoB] }, repoC, "secret.md");
    expect(out).toContain("没有参考这个工作区的授权");
    expect(out).toContain(repoB);
    expect(out).not.toContain("C 仓的内部信息");
  });

  it("没有任何授权根 → 说明怎么得到授权", async () => {
    const out = await readCrossMemory({ configDir, roots: () => [] }, repoB);
    expect(out).toContain("@");
  });

  it("roots 现取：中途新增的根立即可读", async () => {
    const roots = [repoB];
    const src = { configDir, roots: () => roots };
    expect(await readCrossMemory(src, repoC, "secret.md")).toContain("没有参考这个工作区的授权");
    roots.push(repoC);
    expect(await readCrossMemory(src, repoC, "secret.md")).toContain("C 仓的内部信息");
  });

  it("id 不能带路径：.. / 子目录 / 非 .md 一律拒绝", async () => {
    const src = { configDir, roots: () => [repoB] };
    for (const id of ["../../repoC/memory/secret.md", "a/b.md", "..\\x.md", "style.txt", ".."]) {
      const out = await readCrossMemory(src, repoB, id);
      expect(out).toContain("id 必须是");
      expect(out).not.toContain("C 仓的内部信息");
    }
  });

  it("id 不存在 → 指路而不是抛错", async () => {
    const out = await readCrossMemory({ configDir, roots: () => [repoB] }, repoB, "nope.md");
    expect(out).toContain("没有 nope.md");
  });

  it("该工作区没有记忆目录 → 如实说没有", async () => {
    const empty = path.join(base, "empty");
    const out = await readCrossMemory({ configDir, roots: () => [empty] }, empty);
    expect(out).toContain("还没有记忆");
  });

  it("单条超过上限 → 截断并留说明", async () => {
    writeFileSync(path.join(memDirOf(repoB), "big.md"), "x".repeat(70 * 1024));
    const out = await readCrossMemory({ configDir, roots: () => [repoB] }, repoB, "big.md");
    expect(out).toContain("记忆过长，已截断");
    expect(out.length).toBeLessThan(70 * 1024);
  });
});

describe("crossMemoryMcpRegistration", () => {
  it("!trusted → null（受限模式不挂）", () => {
    expect(crossMemoryMcpRegistration({ configDir, roots: () => [] }, false)).toBeNull();
  });

  it("没有 configDir → null（防御异常部署形态）", () => {
    expect(crossMemoryMcpRegistration({ configDir: "", roots: () => [] })).toBeNull();
  });

  it("默认挂载，server 名固定", () => {
    const spec = crossMemoryMcpRegistration({ configDir, roots: () => [] });
    expect(spec?.["aide-memory"]).toBeDefined();
  });

  it("放行规则是工具级（不是 server 前缀）", () => {
    expect(MEMORY_READ_RULES).toEqual(["mcp__aide-memory__read_memory"]);
  });
});
