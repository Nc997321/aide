import { getTransport } from "../transport";

export interface MediaPreviewFile {
  path: string;
  title: string;
}

export interface MediaOpenTarget {
  draftKey: string;
  expectedRevision?: string;
  selection?: import("../types/chat").MediaSelection;
}

export interface MediaOpenRequest {
  files: MediaPreviewFile[];
  selected: number;
  target: MediaOpenTarget;
  theme?: Record<string, string>;
}

export interface MediaFeedbackFrame {
  data: string;
  mediaType: "image/png";
}

export interface MediaFeedback {
  id: string;
  draftKey: string;
  ref: import("../types/chat").MediaRef;
  frame?: MediaFeedbackFrame;
}

export interface MediaFeedbackOutcome {
  error?: string;
}

/** Media preview operations are routed through the configured host transport. */
export const mediaApi = {
  open(request: MediaOpenRequest): Promise<void> {
    return getTransport().invoke("media_preview_open", { request });
  },
  feedbackAck(id: string, outcome: MediaFeedbackOutcome): Promise<void> {
    return getTransport().invoke("media_feedback_ack", { id, outcome });
  },
};
