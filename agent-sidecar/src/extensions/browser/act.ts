/**
 * `browser_act` 的编排：解析目标 → 动作 → **如实报告走了哪条路**。
 *
 * # 为什么点击要两条路
 *
 * `browser_eval` 里 `el.click()` 能点，但它跳过事件管线（无 hover/mousedown/mouseup、
 * 非 `isTrusted`），在依赖 mousedown 起效的控件（下拉、菜单、拖拽）上静默失效。所以主路径是
 * 把坐标交给 CDP 的 `Input.dispatchMouseEvent` 派发**真实**输入。
 *
 * 但 WebView2 是 Evergreen 运行时——**CDP 域名可用性随机器版本而变，不是我们构建的固定属性**。
 * 所以必须有兜底；而兜底不是等价的（仍非可信事件），**必须在返回文本里说明用了哪条路**，
 * 让模型自己判断这次点击的可靠性。静默降级会制造"点了但没反应"的幽灵故障。
 *
 * # 方法级错误：比降级更坏的是**报假成功**
 *
 * CDP 的调用失败有两种形状，而桥只认得其中一种：传输层失败会回 `ok:false`，但**方法级拒绝**
 * （`{error:{code,message}}`）是一个合法 JSON 响应体，`drill`（`native.rs:71-78`）只做 JSON
 * 解析，于是它带着 `ok:true` 一路回到这里。不看这个字段，运行时拒绝一次点击时我们会回
 * "Clicked … with a real mouse event via CDP"——**而它根本没点**。
 * （`screenshot.ts:88-98` 早就这么判了，这条路径当初漏了；2026-09-20 走查发现。）
 *
 * 设值（`fill`）不走 CDP：置 value + 派发 `input`/`change` 是纯脚本操作，没有可信事件的问题。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser } from "../browserClient.js";
import { runEval } from "./runEval.js";
import {
  buildClickFallbackScript,
  buildFillScript,
  buildResolveScript,
  type ActTarget,
} from "./actions.js";

/** 工具层能直接用的文本结果。 */
type TextOut = string;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** 目标解析失败时的文本：错误 + 候选清单（帮模型改口径，而不是让它瞎猜）。 */
function describeResolveFailure(v: Record<string, unknown>): string {
  const lines = [`Could not find the target: ${String(v["error"] ?? "unknown")}`];
  const candidates = Array.isArray(v["candidates"]) ? v["candidates"] : [];
  if (candidates.length) {
    lines.push("", "Clickable elements currently on the page (retry with `text` or a `selector` from one of these):");
    for (const c of candidates) {
      const r = asRecord(c);
      if (!r) continue;
      const bits = [`<${String(r["tag"])}>`, `"${String(r["text"])}"`];
      if (r["id"]) bits.push(`#${String(r["id"])}`);
      if (r["name"]) bits.push(`name=${String(r["name"])}`);
      lines.push(`- ${bits.join(" ")}`);
    }
  }
  return lines.join("\n");
}

function describeHit(v: Record<string, unknown>): string {
  const hit = asRecord(v["hit"]);
  if (!hit) return "an element";
  const bits = [`<${String(hit["tag"])}>`, `"${String(hit["text"])}"`];
  if (hit["id"]) bits.push(`#${String(hit["id"])}`);
  return bits.join(" ");
}

/** 跑一段求值脚本、把结果规整成 `{ok, value}`；失败走 `text`。 */
async function evalScript(
  viewId: string | undefined,
  script: string,
  emit: (e: ChatEvent) => void,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; text: TextOut }> {
  const r = await runEval(script, { viewId }, emit);
  // 抛异常 / 不可序列化 / 桥失败，runEval 已经定性并给出面向模型的文本，不加工。
  if (!r.ok) return { ok: false, text: r.error };
  const value = asRecord(r.value);
  // 走到这里还不是对象，只可能是脚本自己返回了非对象（抛异常那一支已在上面分流）。
  if (!value) {
    return { ok: false, text: "The page script returned no usable object (it returned a non-object)." };
  }
  return { ok: true, value };
}

/**
 * CDP 回包里的**方法级错误**——`{error:{code,message}}`。
 *
 * 返回 null = 这次调用真的成了。**不看它的调用点都会报假成功**，见文件头。
 */
function cdpMethodError(data: unknown): string | null {
  const err = asRecord(asRecord(data)?.["value"])?.["error"];
  const e = asRecord(err);
  if (!e) return null;
  return String(e["message"] ?? e["code"] ?? "unknown");
}

/** 一次 CDP 鼠标输入。成了回 `null`，否则回**面向模型的失败原因**。 */
async function cdpMouse(
  viewId: string | undefined,
  params: Record<string, unknown>,
  label: string,
  emit: (e: ChatEvent) => void,
): Promise<string | null> {
  const resp = await queryBrowser(
    { op: "call_cdp", view_id: viewId, method: "Input.dispatchMouseEvent", params },
    emit,
  );
  if (!resp.ok) return `${label} failed: ${resp.error ?? "unknown"}`;
  const rejected = cdpMethodError(resp.data);
  if (rejected) return `${label} was rejected by the runtime: ${rejected}`;
  return null;
}

/**
 * 真实点击：CDP `mousePressed` + `mouseReleased`。两步都要成，缺一不可
 * （只按下不抬起 = 元素停在 pressed 态，比不点更糟）。
 */
async function cdpClick(
  viewId: string | undefined,
  x: number,
  y: number,
  emit: (e: ChatEvent) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const base = { x, y, button: "left", clickCount: 1 };

  const pressed = await cdpMouse(viewId, { type: "mousePressed", ...base }, "mousePressed", emit);
  if (pressed) return { ok: false, reason: pressed };

  const released = await cdpMouse(viewId, { type: "mouseReleased", ...base }, "mouseReleased", emit);
  if (released) {
    // 危险中间态：已按下未抬起。必须说清，让模型知道页面可能停在半按下。
    return {
      ok: false,
      reason: `${released} — mousePressed succeeded, so the element may be left in a pressed state`,
    };
  }
  return { ok: true };
}

/** 点击：先 CDP 真实输入，不可用则脚本派发兜底，并**如实标注**走了哪条路。 */
export async function performClick(
  viewId: string | undefined,
  target: ActTarget,
  emit: (e: ChatEvent) => void,
): Promise<TextOut> {
  const resolved = await evalScript(viewId, buildResolveScript(target), emit);
  if (!resolved.ok) return resolved.text;

  const v = resolved.value;
  // 找不到目标时也该带上隐藏告警：懒加载内容在隐藏视图里根本不会渲染出来。
  if (v["ok"] !== true) return (describeResolveFailure(v));

  const x = Number(v["x"]);
  const y = Number(v["y"]);
  const hit = describeHit(v);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return `Resolved ${hit} but got no usable coordinates — cannot click.`;
  }

  const viaCdp = await cdpClick(viewId, x, y, emit);
  if (viaCdp.ok) {
    return (`Clicked ${hit} with a real mouse event via CDP at (${x}, ${y}).`);
  }

  // 兜底：CDP 不可用（WebView2 版本差异）。**必须说清这不是等价路径。**
  const fallback = await evalScript(viewId, buildClickFallbackScript(target), emit);
  if (!fallback.ok) {
    return `Click failed. CDP path: ${viaCdp.reason}. Script fallback also failed: ${fallback.text}`;
  }
  const fv = fallback.value;
  if (fv["ok"] !== true) {
    return `Click failed. CDP path: ${viaCdp.reason}. Script fallback: ${String(fv["error"] ?? "unknown")}`;
  }
  return (
    `Clicked ${describeHit(fv)} using a SYNTHETIC event (script fallback) — ` +
      `CDP real input was unavailable (${viaCdp.reason}). ` +
      `The click is not a trusted event, so widgets that only react to real input (some dropdowns, ` +
      `file pickers, drag targets) may not respond. Verify the page actually changed.`
  );
}

/** 设值：纯脚本（置 value + 派发 input/change），不涉及可信事件问题。 */
export async function performFill(
  viewId: string | undefined,
  target: ActTarget,
  value: string,
  emit: (e: ChatEvent) => void,
): Promise<TextOut> {
  const r = await evalScript(viewId, buildFillScript(target, value), emit);
  if (!r.ok) return r.text;

  const v = r.value;
  if (v["ok"] !== true) {
    const lines = [`Could not fill the target: ${String(v["error"] ?? "unknown")}`];
    const options = Array.isArray(v["options"]) ? v["options"] : [];
    if (options.length) {
      lines.push("", `<select> options available: ${options.map((o) => String(o)).join(" | ")}`);
    }
    const candidates = Array.isArray(v["candidates"]) ? v["candidates"] : [];
    if (candidates.length) lines.push("", `${candidates.length} other clickable element(s) on the page — retry with a selector.`);
    return (lines.join("\n"));
  }
  return (`Set ${describeHit(v)} to ${JSON.stringify(String(v["value"] ?? value))}.`);
}

/**
 * 悬停：CDP `mouseMoved`（hover 菜单、tooltip 靠它展开）。
 * 不做脚本兜底——合成 mouseover 与真实悬停差异太大，降级了反而误导。
 */
export async function performHover(
  viewId: string | undefined,
  target: ActTarget,
  emit: (e: ChatEvent) => void,
): Promise<TextOut> {
  const resolved = await evalScript(viewId, buildResolveScript(target), emit);
  if (!resolved.ok) return resolved.text;
  const v = resolved.value;
  if (v["ok"] !== true) return (describeResolveFailure(v));

  const x = Number(v["x"]);
  const y = Number(v["y"]);
  const failed = await cdpMouse(viewId, { type: "mouseMoved", x, y }, "mouseMoved", emit);
  if (failed) {
    return (
      `Hover failed at (${x}, ${y}): ${failed}. ` +
      `Real hover needs CDP, which is unavailable in this WebView2 runtime.`
    );
  }
  return (`Hovered ${describeHit(v)} at (${x}, ${y}).`);
}
