/** 动作目录：定位 → 原生输入/明确降级 → 如实结果；批次不解析结果文案。 */
import type { ChatEvent } from "../../engine/types.js";
import {
  buildClickFallbackScript, buildFillScript, buildFocusScript,
  buildKeyFallbackScript, buildResolveScript, type ActTarget,
} from "./actions.js";
import { asRecord } from "./format.js";
import type { KeyStroke } from "./keys.js";
import { runEval } from "./runEval.js";
import { describeHit, describeResolveFailure, matchNote } from "./act/format.js";
import { clickInput, dispatchInput } from "./act/input.js";
import { done, failed, uncertain, type ActionContext, type ActionOutcome } from "./act/result.js";

export { describeResolveFailure, matchNote } from "./act/format.js";
export type { ActionContext, ActionOutcome } from "./act/result.js";

export interface PressRequest {
  target: ActTarget;
  stroke: KeyStroke;
  raw: { key: string; modifiers: string[] };
}

type ScriptOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; text: string };
export const CLICK_SETTLE_MS = 250;

async function evalScript(context: ActionContext, script: string): Promise<ScriptOutcome> {
  const result = await runEval(script, { viewId: context.viewId }, context.emit);
  if (!result.ok) return { ok: false, text: result.error };
  const value = asRecord(result.value);
  return value ? { ok: true, value } : {
    ok: false, text: "The page script returned no usable object (it returned a non-object).",
  };
}

/** 批次复用此入口：每步不盲等 250ms，最后统一观测，异步依赖由 wait_for 表达。 */
export async function performClick(context: ActionContext, target: ActTarget): Promise<ActionOutcome> {
  const resolved = await evalScript(context, buildResolveScript(target));
  if (!resolved.ok) return failed(resolved.text);
  const value = resolved.value;
  if (value["ok"] !== true) return failed(describeResolveFailure(value));
  return clickResolved(context, { target, value });
}

async function clickResolved(
  context: ActionContext,
  resolved: { target: ActTarget; value: Record<string, unknown> },
): Promise<ActionOutcome> {
  const { target, value } = resolved;
  const point = { x: Number(value["x"]), y: Number(value["y"]) };
  const hit = describeHit(value);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return failed(`Resolved ${hit} but got no usable coordinates — cannot click.`);
  }
  const input = await clickInput(context, point);
  if (input.status === "done") {
    return done(`Clicked ${hit} with a real mouse event via CDP at (${point.x}, ${point.y})${matchNote(value)}.`);
  }
  if (input.status === "uncertain") return uncertain(input.reason);
  if (input.status === "failed") return failed(input.reason);
  return syntheticClick(context, target, input.reason);
}

async function syntheticClick(context: ActionContext, target: ActTarget, reason: string): Promise<ActionOutcome> {
  const fallback = await evalScript(context, buildClickFallbackScript(target));
  if (!fallback.ok) return uncertain(`Click failed. CDP path: ${reason}. Script fallback also failed: ${fallback.text}`);
  const value = fallback.value;
  if (value["ok"] !== true) return failed(`Click failed. CDP path: ${reason}. Script fallback: ${String(value["error"] ?? "unknown")}`);
  return done(
    `Clicked ${describeHit(value)} using a SYNTHETIC event (script fallback)${matchNote(value)} — ` +
    `CDP real input was unavailable (${reason}). The click is not a trusted event, so widgets that only react ` +
    "to real input (some dropdowns, file pickers, drag targets) may not respond. Verify the page actually changed.",
  );
}

export async function performFill(
  viewId: string | undefined, target: ActTarget, value: string, emit: (event: ChatEvent) => void,
): Promise<ActionOutcome> {
  const result = await evalScript({ viewId, emit }, buildFillScript(target, value));
  if (!result.ok) return uncertain(result.text);
  return describeFill(result.value, value);
}

function describeFill(result: Record<string, unknown>, expected: string): ActionOutcome {
  if (result["ok"] !== true) {
    const text = result["candidatesKind"]
      ? describeResolveFailure(result) : `Could not fill the target: ${String(result["error"] ?? "unknown")}`;
    const options = Array.isArray(result["options"]) ? result["options"] : [];
    return failed(text + (options.length ? `\n\n<select> options available: ${options.map(String).join(" | ")}` : ""));
  }
  const events = Array.isArray(result["events"]) ? result["events"].map(String).filter(Boolean) : [];
  const how = events.length ? ` (dispatched ${events.join(" + ")})` : "";
  return done(`Set ${describeHit(result)} to ${JSON.stringify(String(result["value"] ?? expected))}${how}${matchNote(result)}.`);
}

export async function performPress(
  viewId: string | undefined, request: PressRequest, emit: ActionContext["emit"],
): Promise<ActionOutcome> {
  const context = { viewId, emit };
  const focused = await evalScript(context, buildFocusScript(request.target));
  if (!focused.ok) return failed(focused.text);
  if (focused.value["ok"] !== true) return failed(describeResolveFailure(focused.value));
  return pressFocused(context, request, focused.value);
}

async function pressFocused(
  context: ActionContext, request: PressRequest, focused: Record<string, unknown>,
): Promise<ActionOutcome> {
  const down = await dispatchInput(context, { method: "Input.dispatchKeyEvent", params: request.stroke.down });
  if (down.status === "uncertain") return uncertain(down.reason);
  if (down.status === "failed") return failed(down.reason);
  if (down.status === "unavailable") return syntheticKey(context, request, down.reason);
  const up = await dispatchInput(context, { method: "Input.dispatchKeyEvent", params: request.stroke.up });
  if (up.status !== "done") {
    return uncertain(`${up.reason} — keyDown was delivered, so the key may be left held down.`);
  }
  return done(`Pressed ${request.stroke.label} on ${describeHit(focused)} with a real key event via CDP${matchNote(focused)}.`);
}

async function syntheticKey(context: ActionContext, request: PressRequest, reason: string): Promise<ActionOutcome> {
  const fallback = await evalScript(context, buildKeyFallbackScript(request.target, request.raw.key, request.stroke.code, request.raw.modifiers));
  if (!fallback.ok) return uncertain(`Press failed. CDP path: ${reason}. Script fallback also failed: ${fallback.text}`);
  const value = fallback.value;
  if (value["ok"] !== true) return failed(`Press failed. CDP path: ${reason}. Script fallback: ${String(value["error"] ?? "unknown")}`);
  return done(
    `Pressed ${request.stroke.label} on ${describeHit(value)} using a SYNTHETIC event (script fallback)` +
    `${matchNote(value)} — CDP real key input was unavailable (${reason}). A synthetic key does not move ` +
    "focus, does not type, and is not trusted, so widgets that only react to real input may ignore it. Verify the page actually changed.",
  );
}

export async function performHover(
  viewId: string | undefined, target: ActTarget, emit: ActionContext["emit"],
): Promise<ActionOutcome> {
  const context = { viewId, emit };
  const resolved = await evalScript(context, buildResolveScript(target));
  if (!resolved.ok) return failed(resolved.text);
  if (resolved.value["ok"] !== true) return failed(describeResolveFailure(resolved.value));
  return hoverResolved(context, resolved.value);
}

async function hoverResolved(context: ActionContext, value: Record<string, unknown>): Promise<ActionOutcome> {
  const point = { x: Number(value["x"]), y: Number(value["y"]) };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return failed("Resolved target has no usable coordinates — cannot hover.");
  const input = await dispatchInput(context, { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", ...point } });
  if (input.status === "uncertain") return uncertain(`Hover failed: ${input.reason}`);
  if (input.status !== "done") return failed(`Hover failed: ${input.reason}. Real hover needs CDP, which is unavailable in this WebView2 runtime.`);
  return done(`Hovered ${describeHit(value)} at (${point.x}, ${point.y})${matchNote(value)}.`);
}
