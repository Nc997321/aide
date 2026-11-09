import { queryBrowser } from "../../browserClient.js";
import { asRecord, cdpMethodError } from "../format.js";
import type { ActionContext } from "./result.js";

type InputRequest = { method: string; params: Record<string, unknown> };
export type InputOutcome =
  | { status: "done" }
  | { status: "unavailable" | "failed" | "uncertain"; reason: string };

/** 只有明确的 method-not-found 才可降级；桥错误不证明输入没有送达。 */
export async function dispatchInput(context: ActionContext, input: InputRequest): Promise<InputOutcome> {
  const response = await queryBrowser({ op: "call_cdp", view_id: context.viewId, ...input }, context.emit);
  const label = String(input.params["type"] ?? input.method);
  if (!response.ok) {
    return {
      status: response.dispatched === false ? "failed" : "uncertain",
      reason: `${label} failed: ${response.error ?? "unknown"}`,
    };
  }
  const error = cdpMethodError(response.data);
  if (!error) return { status: "done" };
  const code = asRecord(asRecord(asRecord(response.data)?.["value"])?.["error"])?.["code"];
  return {
    status: code === -32601 ? "unavailable" : "failed",
    reason: `${label} was rejected by the runtime: ${error}`,
  };
}

export async function clickInput(context: ActionContext, point: { x: number; y: number }): Promise<InputOutcome> {
  const params = { ...point, button: "left", clickCount: 1 };
  const pressed = await dispatchInput(context, {
    method: "Input.dispatchMouseEvent", params: { type: "mousePressed", ...params },
  });
  if (pressed.status !== "done") return pressed;
  const released = await dispatchInput(context, {
    method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...params },
  });
  return released.status === "done" ? released : {
    status: "uncertain",
    reason: `${released.reason} — mousePressed succeeded, so the element may be left in a pressed state`,
  };
}
