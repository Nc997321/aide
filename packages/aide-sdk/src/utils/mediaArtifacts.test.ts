import { describe, expect, it } from "vitest";
import { collectMediaArtifacts, isMediaFilePath } from "./mediaArtifacts";

describe("media Markdown artifact extraction", () => {
  it("extracts deduplicated local media links but not code fences or remote links", () => {
    const blocks = [{ type: "text", text: [
      "Watch [clip](assets/a.mp4) and ![sound](./assets/a.mp4).",
      "[remote](https://example.com/b.mp4)",
      "```md\n[example](hidden.mp4)\n```",
    ].join("\n") }];
    expect(collectMediaArtifacts(blocks, "C:/work")).toEqual([
      { path: "C:/work/assets/a.mp4", title: "clip" },
    ]);
  });

  it("recognizes supported media extensions", () => {
    expect(isMediaFilePath("movie.webm?download=1")).toBe(true);
    expect(isMediaFilePath("notes.md")).toBe(false);
  });
});
