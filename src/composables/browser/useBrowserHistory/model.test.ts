import { describe, expect, it } from "vitest";
import { historyUrl, mergeRecents, parseHistory, persistentHistory, recentKey, type BrowserRecent } from "./model";

const web = (url: string, visitedAt = 100): BrowserRecent => ({ kind: "web", title: url, url, visitedAt });

describe("browser history model", () => {
  it("keeps the latest visit per URL and caps records at 200", () => {
    const records = Array.from({ length: 220 }, (_, index) => web(`https://example.test/${index}`, index + 1));
    const merged = mergeRecents([web("https://example.test/0", 999), ...records]);
    expect(merged).toHaveLength(200);
    expect(merged[0]?.visitedAt).toBe(999);
    expect(merged.filter((entry) => entry.kind === "web" && entry.url.endsWith("/0"))).toHaveLength(1);
  });

  it("does not store private player capability URLs or URL credentials", () => {
    expect(historyUrl(`http://127.0.0.1:1234/media/${"a".repeat(48)}/player`)).toBeNull();
    expect(historyUrl(`http://localhost:1234/media/${"a".repeat(48)}/stream`)).toBeNull();
    expect(historyUrl("https://user:secret@example.test")).toBeNull();
    expect(historyUrl("javascript:alert(1)")).toBeNull();
    expect(historyUrl("about:blank")).toBeNull();
    expect(historyUrl("http://localhost:3000/studio")).toBe("http://localhost:3000/studio");
    expect(historyUrl("file:///project/preview.html")).toBe("file:///project/preview.html");
  });

  it("does not persist unresolved drafts, but retains confirmed session targets", () => {
    const draft: BrowserRecent = { kind: "creation", mode: "create", title: "片子", visitedAt: 100, target: { kind: "draft", key: "blank:tab-1" } };
    const saved: BrowserRecent = { ...draft, target: { kind: "session", key: "sid-1" } };
    expect(persistentHistory([draft, saved])).toEqual([saved]);
    expect(recentKey(draft)).not.toBe(recentKey(saved));
  });

  it("defaults to an empty history and hidden bookmark bar", () => {
    expect(parseHistory(null)).toEqual({ version: 1, records: [], showBookmarkBar: false });
  });

  it("round-trips only validated fields and refuses corrupted records", () => {
    const saved = { version: 1, records: [web("https://example.test/")], showBookmarkBar: true };
    expect(parseHistory(JSON.stringify(saved))).toEqual(saved);
    expect(() => parseHistory("{broken")).toThrow();
    expect(() => parseHistory(JSON.stringify({ ...saved, version: 7 }))).toThrow("未覆盖原记录");
    expect(() => parseHistory(JSON.stringify({ ...saved, records: [{ ...saved.records[0], visitedAt: "yesterday" }] }))).toThrow("无效条目");
    expect(() => parseHistory(JSON.stringify({ ...saved, records: [{ kind: "media", title: "x", path: "/clip.mp4", visitedAt: 1, target: { kind: "draft", key: "blank:x" } }] }))).toThrow("无效条目");
  });
});
