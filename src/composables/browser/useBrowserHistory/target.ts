import { useComposerDrafts } from "@aide/sdk/composables/useComposerDrafts";
import { useSessionNames } from "@aide/sdk/composables/useSessionNames";
import { finalizedSids } from "@aide/sdk/composables/useChatSession/state";
import type { BrowserRecordTarget } from "./model";

/** 正向确认：已从 Host 载入名字的旧会话，或已收到 session_init 的新会话。 */
export function browserRecordTarget(draftKey: string): BrowserRecordTarget {
  const key = useComposerDrafts().resolveDraftKey(draftKey);
  const confirmed = finalizedSids.has(key) || Object.prototype.hasOwnProperty.call(useSessionNames().names, key);
  return { kind: confirmed ? "session" : "draft", key };
}
