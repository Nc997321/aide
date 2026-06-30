import { describe, it, expect } from "vitest";
import { resolvePastePayload } from "./paste";
import type { ClipboardEntry } from "../composables/useFileClipboard";

describe("resolvePastePayload", () => {
  it("uses OS files first", () => {
    expect(resolvePastePayload(["C:\\a.png", "C:\\b.txt"], null, null, "x"))
      .toBe("@C:\\a.png @C:\\b.txt ");
  });

  it("uses image when no files", () => {
    expect(resolvePastePayload([], "/tmp/aide-clipboard/img-1.png", null, "x"))
      .toBe("@/tmp/aide-clipboard/img-1.png ");
  });

  it("uses in-app clipboard entry when no files/image", () => {
    const entry: ClipboardEntry = { op: "copy", path: "/proj/f.ts" };
    expect(resolvePastePayload([], null, entry, "x")).toBe("@/proj/f.ts ");
  });

  it("ignores in-app cut entry", () => {
    const entry: ClipboardEntry = { op: "cut", path: "/proj/f.ts" };
    expect(resolvePastePayload([], null, entry, "fallback")).toBe("fallback");
  });

  it("falls back to text", () => {
    expect(resolvePastePayload([], null, null, "hello\nworld")).toBe("hello\nworld");
  });

  it("returns empty when nothing available", () => {
    expect(resolvePastePayload([], null, null, "")).toBe("");
  });
});