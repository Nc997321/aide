import { describe, it, expect } from "vitest";
import { resolvePastePayload } from "./paste";
import type { ClipboardEntry } from "../composables/useFileClipboard";

describe("resolvePastePayload", () => {
  it("splits OS files: text files become @path, image files become imagePaths", () => {
    const r = resolvePastePayload(["C:\\a.png", "C:\\b.ts"], null, null, "x");
    expect(r.text).toBe("@C:\\b.ts ");
    expect(r.imagePaths).toEqual(["C:\\a.png"]);
  });

  it("all OS files are images: text is empty, all go to imagePaths", () => {
    const r = resolvePastePayload(["C:\\a.png", "C:\\b.jpg"], null, null, "x");
    expect(r.text).toBe("");
    expect(r.imagePaths).toEqual(["C:\\a.png", "C:\\b.jpg"]);
  });

  it("all OS files are text: imagePaths is empty", () => {
    const r = resolvePastePayload(["C:\\a.ts", "C:\\b.rs"], null, null, "x");
    expect(r.text).toBe("@C:\\a.ts @C:\\b.rs ");
    expect(r.imagePaths).toEqual([]);
  });

  it("clipboard image goes to imagePaths, text is empty", () => {
    const r = resolvePastePayload([], "/tmp/aide-clipboard/img-1.png", null, "x");
    expect(r.text).toBe("");
    expect(r.imagePaths).toEqual(["/tmp/aide-clipboard/img-1.png"]);
  });

  it("in-app copy entry becomes @path text when plain text is empty", () => {
    const entry: ClipboardEntry = { op: "copy", paths: ["/proj/f.ts"] };
    const r = resolvePastePayload([], null, entry, "");
    expect(r.text).toBe("@/proj/f.ts ");
    expect(r.imagePaths).toEqual([]);
  });

  it("multi-path in-app copy entry joins all @path mentions", () => {
    const entry: ClipboardEntry = { op: "copy", paths: ["/proj/a.ts", "/proj/b.ts"] };
    const r = resolvePastePayload([], null, entry, "");
    expect(r.text).toBe("@/proj/a.ts @/proj/b.ts ");
    expect(r.imagePaths).toEqual([]);
  });

  it("plain text wins over in-app copy entry", () => {
    const entry: ClipboardEntry = { op: "copy", paths: ["/proj/f.ts"] };
    const r = resolvePastePayload([], null, entry, "hello world");
    expect(r.text).toBe("hello world");
    expect(r.imagePaths).toEqual([]);
  });

  it("in-app cut entry is ignored, falls through to plain text", () => {
    const entry: ClipboardEntry = { op: "cut", paths: ["/proj/f.ts"] };
    const r = resolvePastePayload([], null, entry, "fallback");
    expect(r.text).toBe("fallback");
    expect(r.imagePaths).toEqual([]);
  });

  it("plain text fallback", () => {
    const r = resolvePastePayload([], null, null, "hello\nworld");
    expect(r.text).toBe("hello\nworld");
    expect(r.imagePaths).toEqual([]);
  });

  it("empty everything returns empty resolution", () => {
    const r = resolvePastePayload([], null, null, "");
    expect(r.text).toBe("");
    expect(r.imagePaths).toEqual([]);
  });
});
