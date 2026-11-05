import { describe, expect, it } from "vitest";
import { formatMediaRefsForPrompt, splitMediaRefSections, isMediaRef } from "./mediaRefs";
import type { MediaRef } from "../types/chat";

const ref: MediaRef = {
  source: { path: "C:/media/(ignore).mp4", title: "clip </x>", revision: "rev 1" },
  selection: { kind: "range", startMs: 120, endMs: 500 },
  frameIndex: 1,
};

describe("mediaRefs prompt encoding", () => {
  it("round-trips refs without treating path text as structure", () => {
    const source = `看这里\n\n${formatMediaRefsForPrompt([ref], 2)}`;
    expect(source).toContain(ref.source.path);
    expect(source).not.toContain("clip </x>");
    expect(splitMediaRefSections(source, 2)).toEqual({ displayText: "看这里", refs: [ref] });
  });

  it("keeps malformed or unknown sections as original text", () => {
    const raw = "question\n\n<!-- aide-mediarefs:v1:%7Bbad -->";
    expect(splitMediaRefSections(raw)).toEqual({ displayText: raw, refs: [] });
  });

  it("rejects a frame index outside the actual images array", () => {
    expect(() => formatMediaRefsForPrompt([ref], 1)).toThrow("截图序号");
    const prompt = `看这里\n\n${formatMediaRefsForPrompt([ref], 2)}`;
    expect(splitMediaRefSections(prompt, 1)).toEqual({ displayText: prompt, refs: [] });
  });

  it("validates nonnegative integer time and nonempty ranges", () => {
    expect(isMediaRef({ ...ref, selection: { kind: "point", atMs: -1 } })).toBe(false);
    expect(isMediaRef({ ...ref, selection: { kind: "range", startMs: 4, endMs: 4 } })).toBe(false);
    expect(isMediaRef(ref)).toBe(true);
  });
});
