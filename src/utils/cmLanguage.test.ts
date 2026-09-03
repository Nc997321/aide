import { describe, it, expect } from "vitest";
import { loadLanguageExtension } from "./cmLanguage";

describe("loadLanguageExtension", () => {
  it("已知扩展名返回语言扩展（非空数组）", async () => {
    expect(await loadLanguageExtension("rs")).not.toEqual([]);
    expect(await loadLanguageExtension("ts")).not.toEqual([]);
    expect(await loadLanguageExtension("vue")).not.toEqual([]);
    expect(await loadLanguageExtension("yml")).not.toEqual([]);
    expect(await loadLanguageExtension("yaml")).not.toEqual([]);
    expect(await loadLanguageExtension("properties")).not.toEqual([]);
    expect(await loadLanguageExtension("jsonl")).not.toEqual([]);
    expect(await loadLanguageExtension("sql")).not.toEqual([]);
    expect(await loadLanguageExtension("sh")).not.toEqual([]);
    expect(await loadLanguageExtension("bash")).not.toEqual([]);
    expect(await loadLanguageExtension("zsh")).not.toEqual([]);
    expect(await loadLanguageExtension("ps1")).not.toEqual([]);
  });

  it("未知扩展名返回空数组", async () => {
    expect(await loadLanguageExtension("zztop")).toEqual([]);
    expect(await loadLanguageExtension("")).toEqual([]);
  });
});
