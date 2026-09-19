import { describe, it, expect } from "vitest";
import { thinkingDisabledFor } from "./thinkingPolicy.js";

describe("thinkingDisabledFor", () => {
  it("automation 会话恒关，与档位无关", () => {
    expect(thinkingDisabledFor({ automation: true, thinkingEnabled: true })).toBe(true);
    expect(thinkingDisabledFor({ automation: true, thinkingEnabled: false })).toBe(true);
  });

  it("普通会话由档位决定（快速 ⇒ 关）", () => {
    expect(thinkingDisabledFor({ automation: false, thinkingEnabled: false })).toBe(true);
    expect(thinkingDisabledFor({ automation: false, thinkingEnabled: true })).toBe(false);
  });
});
