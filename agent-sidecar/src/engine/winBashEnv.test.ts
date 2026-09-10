import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bashrcPath, ensureWindowsBashEnv } from "./winBashEnv.js";
import { toForwardSlashes } from "./winPaths.js";

const tmpDirs: string[] = [];

function tmpConfigDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aide-winbashenv-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("ensureWindowsBashEnv", () => {
  it("win32：落地 bashrc 并设置 BASH_ENV（正斜杠路径）", () => {
    const env = { CLAUDE_CONFIG_DIR: tmpConfigDir() } as Record<string, string>;
    ensureWindowsBashEnv(env, "win32");
    expect(env.BASH_ENV).toBeTruthy();
    expect(env.BASH_ENV).not.toContain("\\");
    const content = readFileSync(env.BASH_ENV!, "utf8");
    expect(content).toContain("chcp.com 65001");
  });

  it("win32：用户已自设 BASH_ENV 时尊重用户，不覆盖", () => {
    const env = {
      CLAUDE_CONFIG_DIR: tmpConfigDir(),
      BASH_ENV: "D:/my-own/bashrc",
    } as Record<string, string>;
    ensureWindowsBashEnv(env, "win32");
    expect(env.BASH_ENV).toBe("D:/my-own/bashrc");
  });

  it("win32：内容过旧时刷新文件", () => {
    const dir = tmpConfigDir();
    const env = { CLAUDE_CONFIG_DIR: dir } as Record<string, string>;
    writeFileSync(path.join(dir, "aide-bashrc"), "# 旧内容\n", "utf8");
    ensureWindowsBashEnv(env, "win32");
    expect(readFileSync(path.join(dir, "aide-bashrc"), "utf8")).toContain("chcp.com 65001");
  });

  it("win32：内容已最新时不重写（mtime 不变）", () => {
    const dir = tmpConfigDir();
    const env = { CLAUDE_CONFIG_DIR: dir } as Record<string, string>;
    ensureWindowsBashEnv(env, "win32");
    const file = path.join(dir, "aide-bashrc");
    writeFileSync(file, readFileSync(file, "utf8"), "utf8"); // 同步 mtime 精度
    const before = readFileSync(file, "utf8");
    ensureWindowsBashEnv(env, "win32");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("非 win32：完全 no-op", () => {
    const env = { CLAUDE_CONFIG_DIR: tmpConfigDir() } as Record<string, string>;
    ensureWindowsBashEnv(env, "linux");
    expect(env.BASH_ENV).toBeUndefined();
  });

  it("配置目录不可写：静默跳过，不抛异常", () => {
    const env = { CLAUDE_CONFIG_DIR: "Z:\\不存在的盘符\\deep\\dir" } as Record<string, string>;
    expect(() => ensureWindowsBashEnv(env, "win32")).not.toThrow();
    expect(env.BASH_ENV).toBeUndefined();
  });
});

// bashrcPath 强制正斜杠输出（winPaths 兜底 bun node:path/fs 缺陷，见 winBashEnv.ts 注释），
// 期望值同样走 toForwardSlashes 归一化，断言聚焦「目录来源 + 文件名」而非分隔符形式。
describe("bashrcPath", () => {
  it("优先用 CLAUDE_CONFIG_DIR", () => {
    expect(bashrcPath({ CLAUDE_CONFIG_DIR: "/x/y" })).toBe(toForwardSlashes(path.join("/x/y", "aide-bashrc")));
  });

  it("缺省回退 ~/.aide/claude", () => {
    expect(bashrcPath({})).toBe(toForwardSlashes(path.join(os.homedir(), ".aide", "claude", "aide-bashrc")));
  });
});
