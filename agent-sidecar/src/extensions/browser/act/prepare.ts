import type { ActTarget } from "../actions.js";
import type { PressRequest } from "../act.js";
import { resolveKey } from "../keys.js";
import { actInputSchema, type ActInput, type StepInput, type WaitFor } from "./schema.js";

export type PreparedAction =
  | { kind: "click" | "hover"; target: ActTarget }
  | { kind: "fill"; target: ActTarget; value: string }
  | { kind: "press"; request: PressRequest };
export type PreparedStep = { action: PreparedAction; wait?: WaitFor };
export type PreparedOperation = { viewId?: string; scope?: string; steps: PreparedStep[] };
type Prepared<T> = { ok: true; value: T } | { ok: false; error: string };

/** 所有语法/参数错误先判完；最后一步键名错误也不能让前几步先写进去。 */
export function prepareOperation(raw: unknown): Prepared<PreparedOperation> {
  const parsed = actInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Invalid browser action: " + parsed.error.issues.slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ") };
  const input = parsed.data;
  const steps = operationSteps(input);
  if (!steps.ok) return steps;
  const prepared = prepareSteps(steps.value);
  return prepared.ok ? { ok: true, value: {
    viewId: input.view_id, scope: input.scope, steps: prepared.value,
  } } : prepared;
}

function operationSteps(input: ActInput): Prepared<StepInput[]> {
  if (input.action !== "batch") {
    if (input.steps !== undefined) return { ok: false, error: "`steps` only applies to action=batch." };
    return { ok: true, value: [{ ...input, action: input.action }] };
  }
  const outer = [input.text, input.selector, input.tag, input.index, input.value, input.key, input.modifiers, input.wait_for];
  if (outer.some((value) => value !== undefined)) {
    return { ok: false, error: "Do not mix batch steps with outer single-action parameters; put targets and wait_for inside steps." };
  }
  return input.steps ? { ok: true, value: input.steps } : { ok: false, error: "action=batch needs 1–8 steps." };
}

function prepareSteps(inputs: StepInput[]): Prepared<PreparedStep[]> {
  const steps: PreparedStep[] = [];
  for (const [index, input] of inputs.entries()) {
    const action = prepareAction(input);
    if (!action.ok) return { ok: false, error: `Step ${index + 1}: ${action.error}` };
    const waitError = validateWait(input.wait_for);
    if (waitError) return { ok: false, error: `Step ${index + 1}: ${waitError}` };
    steps.push({ action: action.value, wait: input.wait_for });
  }
  return { ok: true, value: steps };
}

function prepareAction(input: StepInput): Prepared<PreparedAction> {
  const bad = validateAction(input);
  if (bad) return { ok: false, error: bad };
  const target = { selector: input.selector, text: input.text, tag: input.tag, index: input.index };
  if (input.action === "click" || input.action === "hover") return { ok: true, value: { kind: input.action, target } };
  if (input.action === "fill") return { ok: true, value: { kind: "fill", target, value: input.value ?? "" } };
  const raw = { key: input.key ?? "", modifiers: input.modifiers ?? [] };
  const stroke = resolveKey(raw.key, raw.modifiers);
  return stroke.ok ? { ok: true, value: { kind: "press", request: { target, raw, stroke } } } : stroke;
}

function validateAction(input: StepInput): string | undefined {
  if (input.action === "press") {
    if (!input.key) return 'action=press needs `key` — e.g. "Enter", "Escape", "Tab". Without a target the key goes to the element that currently has focus.';
    if (input.value !== undefined) return "`value` only applies to action=fill.";
    return undefined;
  }
  if (!input.selector && !input.text) return "Give a target: either `text` (the visible label) or `selector` (CSS).";
  if (input.key !== undefined || input.modifiers !== undefined) return '`key` / `modifiers` only apply to action="press".';
  if (input.action === "fill" && input.value === undefined) return "action=fill needs `value`.";
  if (input.action !== "fill" && input.value !== undefined) return "`value` only applies to action=fill.";
  return undefined;
}

function validateWait(wait: WaitFor | undefined): string | undefined {
  if (!wait) return undefined;
  if (wait.until === "load") return wait.condition === undefined ? undefined : "load does not accept condition.";
  if (!wait.condition?.trim()) return "wait_for needs a synchronous condition (or until=load).";
  try {
    new Function(`return (${wait.condition});`);
    return undefined;
  } catch (error) {
    return `Invalid wait_for expression: ${error instanceof Error ? error.message : String(error)}`;
  }
}
