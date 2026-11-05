import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../transport", () => ({ getTransport: () => ({ invoke }) }));

import { mediaApi } from "./media";

describe("mediaApi", () => {
  beforeEach(() => invoke.mockReset().mockResolvedValue(undefined));

  it("opens a media preview through the configured transport", async () => {
    const request = {
      files: [{ path: "C:/project/clip.mp4", title: "片段" }],
      selected: 0,
      target: { draftKey: "session-1" },
      theme: { "--aide-accent": "#123" },
    };
    await mediaApi.open(request);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("media_preview_open", { request });
  });

  it("acknowledges feedback only through the configured transport", async () => {
    await mediaApi.feedbackAck("fb-1", { error: "原草稿已关闭" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("media_feedback_ack", {
      id: "fb-1",
      outcome: { error: "原草稿已关闭" },
    });
  });
});
