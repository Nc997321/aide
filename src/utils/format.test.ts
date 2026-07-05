import { describe, it, expect } from "vitest";
import { formatCompactNumber } from "./format";

describe("formatCompactNumber", () => {
  it("leaves numbers under 1000 untouched (没必要为个位数套 k)", () => {
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(42)).toBe("42");
    expect(formatCompactNumber(999)).toBe("999");
  });

  it("formats thousands with one decimal below 100k", () => {
    expect(formatCompactNumber(1000)).toBe("1.0k");
    expect(formatCompactNumber(36108)).toBe("36.1k");
    expect(formatCompactNumber(1234)).toBe("1.2k");
  });

  it("drops the decimal once the compact value reaches 100+ (150170 → 150k, not 150.2k)", () => {
    expect(formatCompactNumber(150170)).toBe("150k");
    expect(formatCompactNumber(999_999)).toBe("1000k");
  });

  it("switches to millions above 1,000,000", () => {
    expect(formatCompactNumber(1_000_000)).toBe("1.0m");
    expect(formatCompactNumber(2_500_000)).toBe("2.5m");
  });

  it("handles negative numbers by magnitude (defensive; tokens are never negative in practice)", () => {
    expect(formatCompactNumber(-36108)).toBe("-36.1k");
  });
});
