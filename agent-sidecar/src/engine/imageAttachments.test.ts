import { describe, it, expect } from "vitest";
import { normalizeInlineImages } from "./imageAttachments.js";

describe("normalizeInlineImages — send 入口校验", () => {
  it("无 images / 空数组 → undefined（保持「不发该字段」的既有语义）", () => {
    expect(normalizeInlineImages(undefined)).toBeUndefined();
    expect(normalizeInlineImages([])).toBeUndefined();
  });

  it("**同步**返回（不返回 Promise）——send 的同步前缀依赖这点", () => {
    const out = normalizeInlineImages([{ data: "aGk=", mediaType: "image/jpeg" }]);
    expect(out).toEqual([{ data: "aGk=", mediaType: "image/jpeg" }]);
    expect(out).not.toBeInstanceOf(Promise);
  });

  it("缺 data / 缺 mediaType → 抛出（stdin 面无 schema，这里补齐判据）", () => {
    expect(() => normalizeInlineImages([{ data: "", mediaType: "image/png" }])).toThrow(/缺 data/);
    expect(() => normalizeInlineImages([{ data: "aGk=" } as never])).toThrow(/mediaType/);
  });
});
