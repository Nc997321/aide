import { asRecord, formatRead, str } from "../format.js";
import { buildProjectionScript } from "../projection.js";
import { diffLines } from "../readDiff.js";
import { runEval } from "../runEval.js";
import type { ActionContext } from "./result.js";

export const OPERATION_OBSERVATION_MARKER = "/* aide-browser operation observation */";
const MAX_LINES = 80;
const MAX_CHARS = 6_000;

export type Observation =
  | { ok: true; viewId: string; rendered: string; origin: number | null; url: string; title: string }
  | { ok: false; text: string };

/** 私有前后快照，不写 browser_read 的进程级底稿，也不自动遍历帧内容。 */
export async function observeOperation(context: ActionContext, scope?: string): Promise<Observation> {
  const script = `${OPERATION_OBSERVATION_MARKER} (() => {
    const projection = ${buildProjectionScript({ scope, frames: "summary" })};
    return { projection, origin: performance.timeOrigin };
  })()`;
  const result = await runEval(script, { viewId: context.viewId }, context.emit);
  if (!result.ok) return { ok: false, text: result.error };
  const value = asRecord(result.value);
  const projection = asRecord(value?.["projection"]);
  if (!projection || projection["ok"] !== true) {
    return { ok: false, text: `Page observation unavailable: ${str(projection?.["error"]) || "no usable projection"}` };
  }
  const viewId = result.viewId;
  if (!viewId) return { ok: false, text: "The host did not identify the browser view; no actions were sent." };
  return {
    ok: true, viewId,
    rendered: formatRead({ ...result, value: projection }, undefined, { fullText: true }),
    origin: typeof value?.["origin"] === "number" ? value["origin"] : null,
    url: str(projection["url"]), title: str(projection["title"]),
  };
}

export function describeObservation(before: Observation, after: Observation): string {
  if (!after.ok) return `Page feedback unavailable after the action: ${after.text}. Inspect before retrying.`;
  if (!before.ok) return `No before snapshot: ${before.text}\n${limitFeedback(after.rendered)}`;
  const changedDocument = before.origin !== null && after.origin !== null && before.origin !== after.origin;
  const location = before.url !== after.url ? `URL changed: ${before.url} → ${after.url}.` : "URL unchanged.";
  const title = before.title !== after.title ? ` title changed: "${before.title}" → "${after.title}".` : "";
  const heading = `Page feedback (top document${changedDocument ? "; document replaced" : ""}):\n${location}${title}`;
  const diff = diffLines(before.rendered, after.rendered);
  if (!diff) return `${heading}\nToo large to diff; bounded current snapshot follows.\n${limitFeedback(after.rendered)}`;
  if (!diff.lines.length) {
    return `${heading}\nNo observable changes in this snapshot — this does not prove the action had no effect.`;
  }
  return `${heading}\n${limitFeedback(diff.lines.join("\n"))}`;
}

function limitFeedback(text: string): string {
  const lines = text.split("\n");
  const limited = lines.slice(0, MAX_LINES).join("\n").slice(0, MAX_CHARS);
  return limited.length < text.length
    ? `${limited}\nNOTE: feedback truncated (limit ${MAX_LINES} lines / ${MAX_CHARS} characters); use browser_read with scope for more.`
    : limited;
}
