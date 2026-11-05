import { getTransport } from "@aide/sdk";
import { mediaApi, type MediaFeedback, type MediaFeedbackOutcome } from "@aide/sdk/api/media";
import { useComposerDrafts } from "@aide/sdk/composables/useComposerDrafts";
import { isMediaRef } from "@aide/sdk/utils/mediaRefs";

const MAX_COMPLETED = 128;
const completed = new Map<string, MediaFeedbackOutcome>();
let listener: Promise<() => void> | null = null;

export function installMediaFeedbackBridge(onError: (message: string) => void): Promise<() => void> {
  if (listener) return listener;
  const registration = getTransport().listen<unknown>("media-feedback", (event) => {
    void applyFeedback(event.payload, onError).catch((error: unknown) => onError(`媒体反馈处理失败：${String(error)}`));
  }).then((unlisten) => () => {
    unlisten();
    if (listener === registration) { listener = null; completed.clear(); }
  }).catch((error: unknown) => {
    if (listener === registration) listener = null;
    throw error;
  });
  listener = registration;
  return registration;
}

function parseFeedback(value: unknown): MediaFeedback | null {
  if (!value || typeof value !== "object") return null;
  const feedback = value as Record<string, unknown>;
  if (typeof feedback.id !== "string" || feedback.id.length > 128
    || typeof feedback.draftKey !== "string" || feedback.draftKey.length > 512 || !isMediaRef(feedback.ref)) return null;
  if (feedback.frame != null) {
    if (typeof feedback.frame !== "object") return null;
    const frame = feedback.frame as Record<string, unknown>;
    if (frame.mediaType !== "image/png" || typeof frame.data !== "string" || frame.data.length > 6 * 1024 * 1024) return null;
    return { id: feedback.id, draftKey: feedback.draftKey, ref: feedback.ref, frame: { data: frame.data, mediaType: "image/png" } };
  }
  return { id: feedback.id, draftKey: feedback.draftKey, ref: feedback.ref };
}

async function applyFeedback(value: unknown, onError: (message: string) => void): Promise<void> {
  const feedback = parseFeedback(value);
  if (!feedback) { onError("媒体引用格式无效，未写入草稿"); return; }
  const previous = completed.get(feedback.id);
  if (previous) { await acknowledge(feedback.id, previous, onError); return; }
  const outcome = appendToDraft(feedback);
  completed.set(feedback.id, outcome);
  if (completed.size > MAX_COMPLETED) {
    const oldest = completed.keys().next().value;
    if (oldest !== undefined) completed.delete(oldest);
  }
  await acknowledge(feedback.id, outcome, onError);
}

function appendToDraft(feedback: MediaFeedback): MediaFeedbackOutcome {
  const draft = useComposerDrafts().existingDraftOf(feedback.draftKey);
  if (!draft) return { error: "原草稿已关闭，媒体结果未写入。" };
  const frame = feedback.frame
    ? { ...feedback.frame, previewUrl: `data:${feedback.frame.mediaType};base64,${feedback.frame.data}` }
    : undefined;
  draft.mediaRefs.push(frame ? { ref: feedback.ref, frame } : { ref: feedback.ref });
  return {};
}

async function acknowledge(id: string, outcome: MediaFeedbackOutcome, onError: (message: string) => void): Promise<void> {
  try {
    await mediaApi.feedbackAck(id, outcome);
  } catch (error) {
    const message = String(error);
    // 已写入草稿的重复通知可能迟于 HTTP 等待者结束，不再伪报为写入失败。
    if (/媒体反馈已结束|媒体反馈已结束或过期|媒体页已停止等待反馈/.test(message)) return;
    onError(`媒体结果确认失败：${message}`);
  }
}
