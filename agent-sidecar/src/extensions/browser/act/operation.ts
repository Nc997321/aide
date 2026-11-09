import type { ChatEvent } from "../../../engine/types.js";
import { browserOperationInterruption, remainingBrowserOperationMs, withBrowserOperation } from "../../browserClient/operation.js";
import { CLICK_SETTLE_MS, performClick, performFill, performHover, performPress } from "../act.js";
import { runEval } from "../runEval.js";
import { WAIT_INTERVAL_DEFAULT_MS, WAIT_TIMEOUT_DEFAULT_MS, waitForBrowserOutcome, type WaitOutcome } from "../wait.js";
import { describeObservation, observeOperation, type Observation } from "./observe.js";
import { prepareOperation, type PreparedAction, type PreparedOperation, type PreparedStep } from "./prepare.js";
import { failed, type ActionContext, type ActionOutcome } from "./result.js";

const occupiedViews = new Set<string>();
type StepRecord = { action: ActionOutcome; wait?: WaitOutcome };

export async function performBrowserOperation(raw: unknown, emit: (event: ChatEvent) => void): Promise<string> {
  const prepared = prepareOperation(raw);
  if (!prepared.ok) return prepared.error;
  return withBrowserOperation(() => runOperation(prepared.value, emit));
}

async function runOperation(input: PreparedOperation, emit: ActionContext["emit"]): Promise<string> {
  if (input.viewId && occupiedViews.has(input.viewId)) return "This browser view is busy with another browser_act; no actions were sent.";
  const before = await observeOperation({ viewId: input.viewId, emit }, input.scope);
  if (!before.ok) return `No actions were sent: ${before.text}`;
  if (occupiedViews.has(before.viewId)) return "This browser view is busy with another browser_act; no actions were sent.";
  occupiedViews.add(before.viewId);
  try {
    return await runLocked({ viewId: before.viewId, emit }, input, before);
  } finally {
    occupiedViews.delete(before.viewId);
  }
}

async function runLocked(context: ActionContext, input: PreparedOperation, before: Observation): Promise<string> {
  const records = await runSteps(context, input);
  const last = records.at(-1);
  const lastStep = input.steps[records.length - 1];
  if (last?.action.status === "done" && !last.wait && lastStep?.action.kind === "click") {
    await new Promise((resolve) => setTimeout(resolve, Math.min(CLICK_SETTLE_MS, remainingBrowserOperationMs())));
  }
  const after = await observeOperation(context, input.scope);
  return `${describeRecords(records, input.steps.length)}\n\n${describeObservation(before, after)}`;
}

async function runSteps(context: ActionContext, input: PreparedOperation): Promise<StepRecord[]> {
  const records: StepRecord[] = [];
  for (const step of input.steps) {
    const interruption = browserOperationInterruption();
    if (interruption) { records.push({ action: failed(interruption.error) }); break; }
    const record = await runStep(context, step);
    records.push(record);
    if (record.action.status !== "done" || (record.wait && record.wait.status !== "met")) break;
  }
  return records;
}

async function runStep(context: ActionContext, step: PreparedStep): Promise<StepRecord> {
  const anchor = step.wait?.until === "load" ? await documentAnchor(context) : undefined;
  if (anchor && !anchor.ok) return { action: failed(anchor.error) };
  const action = await runAction(context, step.action);
  if (action.status !== "done" || !step.wait) return { action };
  const wait = await waitForBrowserOutcome({
    viewId: context.viewId, mode: step.wait.until ?? "condition", condition: step.wait.condition,
    timeoutMs: Math.min(step.wait.timeout_ms ?? WAIT_TIMEOUT_DEFAULT_MS, remainingBrowserOperationMs()),
    intervalMs: WAIT_INTERVAL_DEFAULT_MS,
  }, context.emit, anchor?.ok ? anchor.origin : undefined);
  return { action, wait };
}

async function documentAnchor(context: ActionContext): Promise<{ ok: true; origin: number } | { ok: false; error: string }> {
  const result = await runEval("performance.timeOrigin", { viewId: context.viewId }, context.emit);
  if (!result.ok) return result;
  return typeof result.value === "number" && result.value > 0
    ? { ok: true, origin: result.value }
    : { ok: false, error: "Cannot identify the current document for wait_for load; no action was sent." };
}

async function runAction(context: ActionContext, action: PreparedAction): Promise<ActionOutcome> {
  switch (action.kind) {
    case "click": return performClick(context, action.target);
    case "fill": return performFill(context.viewId, action.target, action.value, context.emit);
    case "hover": return performHover(context.viewId, action.target, context.emit);
    case "press": return performPress(context.viewId, action.request, context.emit);
  }
}

function describeRecords(records: StepRecord[], total: number): string {
  const sent = records.filter((record) => record.action.status === "done").length;
  const stopped = records.findIndex((record) => record.action.status !== "done" || (record.wait && record.wait.status !== "met"));
  const summary = stopped < 0
    ? `Executed ${sent}/${total} action(s).`
    : `Stopped at step ${stopped + 1}; ${sent}/${total} action(s) completed, ${total - records.length} later step(s) not executed. No rollback or replay.`;
  const details = records.map((record, index) => {
    const wait = record.wait ? `\n  Expected result ${record.wait.status === "met" ? "CONFIRMED" : "NOT CONFIRMED"}: ${record.wait.text}` : "";
    return `${index + 1}. [${record.action.status}] ${record.action.text}${wait}`;
  });
  return [summary, ...details, "Input delivery alone is not business success; only declared waits confirm their expected result."].join("\n");
}
