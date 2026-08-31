import { describe, it, expect } from "vitest";
import { mergeFileEntries } from "./fileTree";
import type { FileEntry } from "../types";

function entry(path: string, is_dir: boolean, children: FileEntry[] | null = null): FileEntry {
  return { name: path.split(/[/\\]/).pop() ?? path, path, is_dir, children };
}

describe("mergeFileEntries 按路径合并（刷新不闪）", () => {
  it("同路径条目复用旧对象：身份保留，已加载的 children 原样保留", () => {
    const loaded = entry("C:\\p\\src", true, [entry("C:\\p\\src\\a.ts")]);
    const oldList = [loaded, entry("C:\\p\\b.ts")];
    const fresh = entry("C:\\p\\src", true);
    const merged = mergeFileEntries(oldList, [fresh, entry("C:\\p\\b.ts")]);
    // 引用相等（toBe 断对象身份），children 引用原样保留
    expect(merged[0].children).toBe(loaded.children);
    expect(merged[0].children).toHaveLength(1);
  });

  it("新路径用新对象，旧对象不泄漏", () => {
    const oldList = [entry("C:\\p\\a.ts")];
    const newcomer = entry("C:\\p\\new.ts");
    const merged = mergeFileEntries(oldList, [entry("C:\\p\\a.ts"), newcomer]);
    expect(merged[1]).toBe(newcomer);
  });

  it("消失的条目剔除、顺序跟随新 entries", () => {
    const oldList = [entry("C:\\p\\a.ts"), entry("C:\\p\\gone.ts"), entry("C:\\p\\b.ts")];
    const merged = mergeFileEntries(oldList, [entry("C:\\p\\b.ts"), entry("C:\\p\\a.ts")]);
    expect(merged.map((n) => n.path)).toStrictEqual(["C:\\p\\b.ts", "C:\\p\\a.ts"]);
  });

  it("is_dir 翻转（目录被删、同名文件顶替）不复用旧对象", () => {
    const oldList = [entry("C:\\p\\thing", true)];
    const nowFile = entry("C:\\p\\thing", false);
    const merged = mergeFileEntries(oldList, [nowFile]);
    expect(merged[0]).toBe(nowFile);
    expect(merged[0].is_dir).toBe(false);
  });

  it("null 旧列表 → 原样出新 entries（首次 expand）", () => {
    const a = entry("C:\\p\\a");
    expect(mergeFileEntries(null, [a])).toStrictEqual([a]);
  });

  it("空新列表 → 清空（目录被清空）", () => {
    const merged = mergeFileEntries([entry("C:\\p\\a.ts")], []);
    expect(merged).toStrictEqual([]);
  });
});