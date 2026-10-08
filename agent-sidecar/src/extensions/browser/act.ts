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
 * （`screenshot.ts:100-101` 早就这么判了，这条路径当初漏了；2026-09-20 走查发现。）
 *
 * 设值（`fill`）不走 CDP：置 value + 派发 `input`/`change` 是纯脚本操作，没有可信事件的问题。
 */
import type { ChatEvent } from "../../engine/types.js";
import { queryBrowser } from "../browserClient.js";
import { cdpMethodError } from "./format.js";
import { runEval } from "./runEval.js";
import {
  buildClickFallbackScript,
  buildFillScript,
  buildFocusScript,
  buildKeyFallbackScript,
  buildResolveScript,
  type ActTarget,
} from "./actions.js";
import type { KeyStroke } from "./keys.js";

/** 工具层能直接用的文本结果。 */
type TextOut = string;

/** `press` 的一次请求：目标 + 已解析的按键 + 模型给的原始键名（合成兜底要用它）。 */
export interface PressRequest {
  target: ActTarget;
  /** `resolveKey` 的产物。键名不认识在**工具层**就拦掉了（本地失败，不发桥）。 */
  stroke: KeyStroke;
  raw: { key: string; modifiers: string[] };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * 目标解析失败时的文本：错误 + 候选清单（帮模型改口径，而不是让它瞎猜）。
 *
 * **导出**：`browser_screenshot` 的元素裁剪走的**同一个**解析脚本（`buildResolveScript`），
 * 判据自然也只有这一份——第二份文案必然漂（"判据分家"是本项目反复治过的病）。
 */
export function describeResolveFailure(v: Record<string, unknown>): string {
  const lines = [`Could not find the target: ${String(v["error"] ?? "unknown")}`];
  const candidates = Array.isArray(v["candidates"]) ? v["candidates"] : [];
  if (candidates.length) {
    // 候选有三种来源（页面脚本给 `candidatesKind`）：页面上**能点的**元素 / 只是**带着这段
    // 文本**的元素（"文本在、但它的元素不被认为可点击"那条分支——说成"可点击元素"会让模型
    // 以为点它就行，实际得改用选择器）/ **selector 自己命中的那一批**（歧义，下一步是给
    // index 或收窄选择器，不是换词）。
    lines.push(
      "",
      v["candidatesKind"] === "text-hits"
        ? "Elements carrying that text (not recognized as clickable — retry with a `selector` from one of these):"
        : v["candidatesKind"] === "selector-matches"
          ? "Elements the selector matched (nothing was written — retry with `index`, or narrow the `selector`):"
          : v["candidatesKind"] === "fields"
            ? "Form fields currently on the page (retry with `text` = one of these labels/names, or a `selector`):"
            : "Clickable elements currently on the page (retry with `text` or a `selector` from one of these):",
    );
    for (const c of candidates) {
      const r = asRecord(c);
      if (!r) continue;
      // 字段常常没有标签（只有 name/placeholder）——空引号像是"标签就叫空串"，直说没有。
      const text = String(r["text"] ?? "");
      const bits = [`<${String(r["tag"])}>`, text ? `"${text}"` : "(no label)"];
      if (r["id"]) bits.push(`#${String(r["id"])}`);
      else if (r["cls"]) bits.push(`.${String(r["cls"])}`);
      if (r["name"]) bits.push(`name=${String(r["name"])}`);
      if (r["type"]) bits.push(`type=${String(r["type"])}`);
      if (r["placeholder"]) bits.push(`placeholder="${String(r["placeholder"])}"`);
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

/**
 * 命中多个时的一句脚注。**只报数字**（用户明确要求"一定要简单"）——`browser_read` 已经能列元素。
 *
 * `index` 越界会被解析脚本钳制（`Math.min`），钳制**要说**：`used index 1` 就是那个交代。
 * 单命中与旧载荷（没有 `matched`）都不出这句——常见路径上不制造噪音。
 *
 * **导出**：`browser_screenshot` 的元素裁剪跑的是**同一个**解析脚本（`buildResolveScript`），
 * 它命中的是第几个必须与这里同一个说法——第二份文案必然漂（同 `describeResolveFailure`）。
 */
export function matchNote(v: Record<string, unknown>): string {
  const n = Number(v["matched"]);
  if (!Number.isFinite(n) || n <= 1) return "";
  const used = Number(v["usedIndex"]);
  return ` (${n} elements matched; used index ${Number.isFinite(used) ? used : 0})`;
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

/** 一次 CDP 输入派发（鼠标 / 键盘共用）。成了回 `null`，否则回**面向模型的失败原因**。 */
async function cdpInput(
  viewId: string | undefined,
  method: string,
  params: Record<string, unknown>,
  label: string,
  emit: (e: ChatEvent) => void,
): Promise<string | null> {
  const resp = await queryBrowser({ op: "call_cdp", view_id: viewId, method, params }, emit);
  if (!resp.ok) return `${label} failed: ${resp.error ?? "unknown"}`;
  const rejected = cdpMethodError(resp.data);
  if (rejected) return `${label} was rejected by the runtime: ${rejected}`;
  return null;
}

/** 一次 CDP 鼠标输入（点击/悬停的公共形状）。 */
function cdpMouse(
  viewId: string | undefined,
  params: Record<string, unknown>,
  label: string,
  emit: (e: ChatEvent) => void,
): Promise<string | null> {
  return cdpInput(viewId, "Input.dispatchMouseEvent", params, label, emit);
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
    return (`Clicked ${hit} with a real mouse event via CDP at (${x}, ${y})${matchNote(v)}.`);
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
  // 注脚紧贴**命中的那个元素**（这条回报的主语），而不是垫在最后那句可靠性警告之后。
  return (
    `Clicked ${describeHit(fv)} using a SYNTHETIC event (script fallback)${matchNote(fv)} — ` +
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
    // 解析失败走**同一份**失败渲染（`candidatesKind` 是它的标志：三种候选各有各的下一步）；
    // fill 自己的失败（读回对不上 / 目标不可填）没有候选，用自己的抬头——把两者混成一句会让
    // 模型拿着"值没落住"的结论去改选择器。
    const lines = [
      v["candidatesKind"]
        ? describeResolveFailure(v)
        : `Could not fill the target: ${String(v["error"] ?? "unknown")}`,
    ];
    const options = Array.isArray(v["options"]) ? v["options"] : [];
    if (options.length) {
      lines.push("", `<select> options available: ${options.map((o) => String(o)).join(" | ")}`);
    }
    return (lines.join("\n"));
  }
  // 派发了哪些事件**必须写出来**（2026-09-29 走查反馈）：受控组件认的是 input/change，而
  // "框架会不会把它当用户输入"是模型判断下一步的依据——它此前只能自己写 eval 去探。
  const events = Array.isArray(v["events"]) ? v["events"].map((e) => String(e)).filter(Boolean) : [];
  const how = events.length ? ` (dispatched ${events.join(" + ")})` : "";
  return (
    `Set ${describeHit(v)} to ${JSON.stringify(String(v["value"] ?? value))}${how}${matchNote(v)}.`
  );
}

/**
 * 按键：**先确定键落在谁身上**（聚焦脚本），再走 CDP 真实按键；不可用则由脚本合成兜底。
 *
 * 存在的理由（2026-09-29 走查反馈，本批最大的缺口）：`el-input` 这类 `change`(blur/Enter) 提交的
 * 控件，`fill` 之后必须"按一下回车"才算完事；没有这条通道时 agent 只能退化成 eval 探 v-model，
 * 一半的兜底都花在这上面。
 *
 * 两发都要成（按下 + 抬起，同点击）：只按下不抬起 = 键卡住，比不按更糟（页面停在按下态）。
 */
export async function performPress(
  viewId: string | undefined,
  req: PressRequest,
  emit: (e: ChatEvent) => void,
): Promise<TextOut> {
  const focused = await evalScript(viewId, buildFocusScript(req.target), emit);
  if (!focused.ok) return focused.text;
  const v = focused.value;
  if (v["ok"] !== true) return describeResolveFailure(v);
  const hit = describeHit(v);

  const down = await cdpInput(
    viewId,
    "Input.dispatchKeyEvent",
    req.stroke.down,
    `${req.stroke.label} keyDown`,
    emit,
  );
  if (!down) {
    const up = await cdpInput(
      viewId,
      "Input.dispatchKeyEvent",
      req.stroke.up,
      `${req.stroke.label} keyUp`,
      emit,
    );
    if (!up) return `Pressed ${req.stroke.label} on ${hit} with a real key event via CDP${matchNote(v)}.`;
    // 危险中间态：已按下未抬起。必须说清，让模型知道这个键可能还按着。
    return (
      `${up} — keyDown was delivered, so the key may be left held down. ` +
      `Press it again, or reload the page, before trusting what the page does next.`
    );
  }

  // 兜底：CDP 不可用（WebView2 版本差异）。**必须说清这不是等价路径。**
  const fallback = await evalScript(
    viewId,
    buildKeyFallbackScript(req.target, req.raw.key, req.stroke.code, req.raw.modifiers),
    emit,
  );
  if (!fallback.ok) {
    return `Press failed. CDP path: ${down}. Script fallback also failed: ${fallback.text}`;
  }
  const fv = fallback.value;
  if (fv["ok"] !== true) {
    return `Press failed. CDP path: ${down}. Script fallback: ${String(fv["error"] ?? "unknown")}`;
  }
  return (
    `Pressed ${req.stroke.label} on ${describeHit(fv)} using a SYNTHETIC event (script fallback)` +
    `${matchNote(fv)} — CDP real key input was unavailable (${down}). A synthetic key does not move ` +
    `focus, does not type, and is not trusted, so widgets that only react to real input may ignore it. ` +
    `Verify the page actually changed.`
  );
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
  return (`Hovered ${describeHit(v)} at (${x}, ${y})${matchNote(v)}.`);
}
