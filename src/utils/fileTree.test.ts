import { describe, it, expect } from "vitest";
import { mergeFileEntries, treeRowPaddingLeft, hoverRevealPaddingLeft } from "./fileTree";
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

describe("hoverRevealPaddingLeft 悬停截断名按需左移", () => {
  it("未截断（缺口 0 或 1px 亚像素容差内）→ 正常 padding，不左移", () => {
    expect(hoverRevealPaddingLeft(5, 0)).toBe(treeRowPaddingLeft(5));
    expect(hoverRevealPaddingLeft(5, 1)).toBe(treeRowPaddingLeft(5));
  });

  it("缺口小于上限 → 只左移实际缺口+2px 余量，不再固定跳满 depth×12", () => {
    // depth 5：正常 98，缺口 20 → 98−22=76（+2px 余量：整数测量贴边拟合会被 ellipsis 放大成截字符）
    expect(hoverRevealPaddingLeft(5, 20)).toBe(98 - 22);
  });

  it("缺口超过可用缩进 → 一直左移到面板左缘（padding 全用完，只留 4px 防贴边）", () => {
    // depth 5：正常 98，缺口 100 > 可用 94 → padding 压到 4px；越过参考线是有意设计
    expect(hoverRevealPaddingLeft(5, 100)).toBe(4);
  });

  it("depth 0 同样按需左移，上限同样是左缘 4px", () => {
    // depth 0 上限只有 4px：缺口 2+余量 2 正好顶满
    expect(hoverRevealPaddingLeft(0, 2)).toBe(4);
    expect(hoverRevealPaddingLeft(0, 50)).toBe(4);
  });
});