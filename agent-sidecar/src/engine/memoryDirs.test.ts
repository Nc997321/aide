// memoryDirs / pathToKey 从 extensions/builtinHooks/memoryEvents.ts 迁到 engine 侧
// （instructions.ts 要用且不依赖 extensions）。本文件钉住迁移后行为不变：与 Rust 侧
// workspace::path_to_key 同规则、dot 归一合并分裂目录。re-export 壳由 memoryEvents.test 覆盖。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToKey, memoryDirs } from "./memoryDirs.js";

const cwd = "C:\\document\\owner\\cypress-agent";
const key = "C--document-owner-cypress-agent";

let root: string;
let configDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "aide-memdirs-"));
  configDir = path.join(root, "claude");
  mkdirSync(path.join(configDir, "projects", key, "memory"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pathToKey", () => {
  it("与 Rust 同规则：`: \\ /` 全部折成 `-`", () => {
    expect(pathToKey(cwd)).toBe(key);
    expect(pathToKey("/a/b/c")).toBe("-a-b-c");
  });
});

describe("memoryDirs", () => {
  it("命中工作区的 memory 目录（只收实际存在的）", () => {
    expect(memoryDirs(configDir, cwd)).toEqual([path.join(configDir, "projects", key, "memory")]);
  });

  it("dot 归一：编码版本不同造成的分裂目录（a.b / a-b）都算同一工作区", () => {
    const dotted = "C:\\document\\owner\\chennong4.0";
    // 旧版 key 带点、新版把点也折成横杠——两边都命中同一个工作区
    mkdirSync(path.join(configDir, "projects", "C--document-owner-chennong4.0", "memory"), {
      recursive: true,
    });
    expect(memoryDirs(configDir, dotted)).toHaveLength(1);
  });

  it("projects 根不存在 / 无命中工作区 → 空数组（不抛）", () => {
    expect(memoryDirs(path.join(root, "nope"), cwd)).toEqual([]);
    expect(memoryDirs(configDir, "D:\\nonexistent")).toEqual([]);
  });
});
