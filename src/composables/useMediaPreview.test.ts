// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetComposerDraftsForTest, useComposerDrafts } from "@aide/sdk/composables/useComposerDrafts";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@aide/sdk/api/media", () => ({ mediaApi: { open } }));

import { useMediaPreview } from "./useMediaPreview";

describe("useMediaPreview", () => {
  beforeEach(() => {
    open.mockReset().mockResolvedValue(undefined);
    __resetComposerDraftsForTest();
  });

  it("creates the selected draft on an explicit open and sends the preview request", async () => {
    const files = [
      { path: "C:/project/clip-a.mp4", title: "开场" },
      { path: "C:/project/clip-b.mp4", title: "结尾" },
    ];

    await useMediaPreview().open({ files, selected: 1, draftKey: "session-7", expectedRevision: "rev-3" });

    expect(useComposerDrafts().existingDraftOf("session-7")).toBeDefined();
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      files,
      selected: 1,
      target: { draftKey: "session-7", expectedRevision: "rev-3" },
      theme: {},
    }));
  });

  it("does not create a draft or call the host for an invalid selection", async () => {
    await useMediaPreview().open({ files: [], selected: 0, draftKey: "closed" });
    expect(useComposerDrafts().existingDraftOf("closed")).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });
});
