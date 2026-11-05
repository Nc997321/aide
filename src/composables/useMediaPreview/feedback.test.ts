// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { __resetComposerDraftsForTest, useComposerDrafts } from "@aide/sdk/composables/useComposerDrafts";

type EventHandler = (event: { payload: unknown }) => void;
const mocks = vi.hoisted(() => ({ listen: vi.fn(), ack: vi.fn(), unlisten: vi.fn() }));
vi.mock("@aide/sdk", () => ({ getTransport: () => ({ listen: mocks.listen }) }));
vi.mock("@aide/sdk/api/media", () => ({ mediaApi: { feedbackAck: mocks.ack } }));

import { installMediaFeedbackBridge } from "./feedback";

const reference = { source: { path: "/clips/a.mp4", title: "第一版", revision: "r1" }, selection: { kind: "point", atMs: 1234 } };
let handler: EventHandler | undefined;
let dispose: (() => void) | undefined;

beforeEach(() => {
  __resetComposerDraftsForTest();
  mocks.ack.mockReset().mockResolvedValue(undefined);
  mocks.unlisten.mockReset();
  mocks.listen.mockReset().mockImplementation((_name: string, callback: EventHandler) => {
    handler = callback;
    return Promise.resolve(mocks.unlisten);
  });
});
afterEach(() => { dispose?.(); dispose = undefined; handler = undefined; });

async function deliver(payload: unknown): Promise<void> {
  if (!handler) throw new Error("media listener was not installed");
  handler({ payload });
  await flushPromises();
}

describe("媒体页只向原草稿写入并确认", () => {
  it("follows draft migration, preserves other text and never dispatches a message", async () => {
    const drafts = useComposerDrafts();
    drafts.draftOf("old").text = "已有意见";
    drafts.migrateDraft("old", "real");
    drafts.draftOf("other").text = "其他会话";
    dispose = await installMediaFeedbackBridge(vi.fn());
    await deliver({ id: "one", draftKey: "old", ref: reference, frame: null });
    expect(drafts.existingDraftOf("real")?.mediaRefs).toEqual([{ ref: reference }]);
    expect(drafts.existingDraftOf("real")?.text).toBe("已有意见");
    expect(drafts.existingDraftOf("other")?.mediaRefs).toEqual([]);
    expect(mocks.ack).toHaveBeenCalledWith("one", {});
  });

  it("does not resurrect a closed draft and returns the failure to the page", async () => {
    const drafts = useComposerDrafts();
    drafts.draftOf("closed");
    drafts.clearDraft("closed");
    dispose = await installMediaFeedbackBridge(vi.fn());
    await deliver({ id: "one", draftKey: "closed", ref: reference });
    expect(drafts.existingDraftOf("closed")).toBeUndefined();
    expect(mocks.ack).toHaveBeenCalledWith("one", { error: expect.stringContaining("已关闭") });
  });

  it("duplicates re-acknowledge without appending a second frame", async () => {
    const draft = useComposerDrafts().draftOf("owner");
    dispose = await installMediaFeedbackBridge(vi.fn());
    const payload = { id: "one", draftKey: "owner", ref: reference, frame: { mediaType: "image/png", data: "AAAA" } };
    await deliver(payload);
    await deliver(payload);
    expect(draft.mediaRefs).toHaveLength(1);
    expect(draft.mediaRefs[0]?.frame?.previewUrl).toBe("data:image/png;base64,AAAA");
    expect(mocks.ack).toHaveBeenCalledTimes(2);
  });

  it("reports acknowledgement failure while preserving the user's accepted draft", async () => {
    const onError = vi.fn();
    const draft = useComposerDrafts().draftOf("owner");
    mocks.ack.mockRejectedValueOnce(new Error("network unavailable"));
    dispose = await installMediaFeedbackBridge(onError);
    const payload = { id: "one", draftKey: "owner", ref: reference };
    await deliver(payload);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("确认失败"));
    await deliver(payload);
    expect(draft.mediaRefs).toHaveLength(1);
  });

  it("rejects malformed payload and can re-install after disposal", async () => {
    const onError = vi.fn();
    const draft = useComposerDrafts().draftOf("owner");
    dispose = await installMediaFeedbackBridge(onError);
    await deliver({ id: "bad", draftKey: "owner", ref: { source: null } });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("格式无效"));
    expect(draft.mediaRefs).toEqual([]);
    dispose();
    dispose = await installMediaFeedbackBridge(onError);
    expect(mocks.listen).toHaveBeenCalledTimes(2);
  });
});
