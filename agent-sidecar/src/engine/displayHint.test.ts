import { describe, expect, it } from "vitest";
import { CHAT_DISPLAY_HINT } from "./displayHint.js";

describe("CHAT_DISPLAY_HINT", () => {
  it("每轮重发，保持短", () => {
    expect(CHAT_DISPLAY_HINT.length).toBeLessThan(600);
  });

  it("给出可照抄的图片语法", () => {
    expect(CHAT_DISPLAY_HINT).toMatch(/!\[[^\]]*\]\(\/[^)]+\.png\)/);
  });
});
