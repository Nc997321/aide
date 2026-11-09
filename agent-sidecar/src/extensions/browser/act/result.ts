import type { ChatEvent } from "../../../engine/types.js";

export type ActionContext = { viewId?: string; emit: (event: ChatEvent) => void };
export type ActionOutcome = { status: "done" | "failed" | "uncertain"; text: string };

export function done(text: string): ActionOutcome {
  return { status: "done", text };
}

export function failed(text: string): ActionOutcome {
  return { status: "failed", text };
}

export function uncertain(text: string): ActionOutcome {
  return { status: "uncertain", text: `${text} Result uncertain — inspect before retrying; no action was replayed.` };
}
