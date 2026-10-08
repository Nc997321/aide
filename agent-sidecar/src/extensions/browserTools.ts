// aide-browser 的工具定义。
//
// 组织：本文件上层只做编排（buildBrowserTools 是一张表），每个工具一个 buildXxxTool。
//
// **工具面里永远不出现站点名词**——「怎么读某个站点」是 skill reference 里的数据，
// 不是这里的能力。验收尺：换一个站点，本文件一行不动。
//
// 权限：三个工具都进 allowedTools 自动放行（见 browserMcp.ts 的说明）。
// **`browser_read` 刻意不收 `script` 参数**——否则「自动放行的读工具」就变成了任意 JS 执行，
// 等于给权限旁路开了个后门。自定义脚本一律走 `browser_eval`。
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "../engine/types.js";
import { queryBrowser, type BrowserCall } from "./browserClient.js";
import { runEval } from "./browser/runEval.js";
import { buildProjectionScript } from "./browser/projection.js";
import {
  describeResolveFailure,
  matchNote,
  performClick,
  performFill,
  performHover,
  performPress,
} from "./browser/act.js";
import { resolveKey } from "./browser/keys.js";
import { performTabAction } from "./browser/tab.js";
import { evalInFrame, readFramesFromResult } from "./browser/frames.js";
import { captureScreenshot } from "./browser/screenshot.js";
import type { ScreenshotClip, ScreenshotFormat } from "./browser/screenshot.js";
import {
  waitForBrowser,
  WAIT_INTERVAL_DEFAULT_MS,
  WAIT_INTERVAL_MIN_MS,
  WAIT_TIMEOUT_DEFAULT_MS,
  WAIT_TIMEOUT_MAX_MS,
} from "./browser/wait.js";
import { buildResolveScript } from "./browser/actions.js";
import type { ActTarget } from "./browser/actions.js";
import { readRecorder } from "./browser/recorder.js";
import { renderNetwork } from "./browser/network.js";
import { renderConsole } from "./browser/console.js";
import {
  asRecord,
  formatBridgeFailure,
  formatEval,
  formatFrameEval,
  formatRead,
  formatTabs,
} from "./browser/format.js";

/** MCP 图像内容块（base64 PNG）。只有截图工具用它——其余一律回文本。 */
type ImageBlock = { type: "image"; data: string; mimeType: string };

// 必须是 type 别名而非 interface：SDK 的 CallToolResult 带索引签名，interface 没有隐式索引签名
// → handler 返回具名 interface 会报 TS2322（同 knowledgeTools.ts 的注释）。
type ToolResult = {
  content: ({ type: "text"; text: string } | ImageBlock)[];
};

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 工具公共壳：发桥 → 失败转文本 → 成功走格式化器。
 * **永不抛**（MCP 会把抛出的 handler 变成 isError，是本模块的红线）。
 */
async function call(
  emit: (e: ChatEvent) => void,
  makeCall: () => BrowserCall,
  render: (data: unknown) => string,
): Promise<ToolResult> {
  try {
    const resp = await queryBrowser(makeCall(), emit);
    if (!resp.ok) return textResult(formatBridgeFailure(resp));
    return textResult(render(resp.data));
  } catch (e) {
    // 归一化以外的异常（格式化器解引用畸形数据等）一律降级为文本，绝不穿出 handler。
    const detail = e instanceof Error ? e.message : String(e);
    return textResult(`Browser tool failed unexpectedly: ${detail}`);
  }
}

/**
 * 各工具共用的 `view_id` 参数：缺省时由 Rust 侧按「唯一可见 → 唯一存在」解析。
 *
 * 文案刻意短：这段说明**在每个工具里各占一份**（schema 逐工具发），7 份加起来是纯重复成本。
 * 三条必须保留的信息（从哪拿 id / 什么时候能省 / 省错会怎样）一条不删，只删修饰。
 */
const viewIdArg = z
  .string()
  .optional()
  .describe(
    "View id from browser_tabs. Omit only when one view is open; ambiguity fails and lists them.",
  );

/** `browser_read` 的隐藏项开关（默认不列，但**报数**——见 format.ts 的那行 NOTE）。 */
const includeHiddenArg = z
  .boolean()
  .optional()
  .describe(
    "Include hidden (display:none) tables / fields / clickables in the skeleton, and the hidden text in " +
      "the raw text section (that section lists rendered text only). " +
      "Default false — hidden poppers are noise. Pass true when the page stacks whole screens " +
      "(design-tool prototypes).",
  );

export function buildBrowserTabsTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_tabs",
    "List the browser views (tabs) currently open in Aide's embedded browser, with each one's id, " +
      "url, title, label and whether it is displayed (on screen for the user) or parked (alive in the " +
      "background — it still renders). " +
      "Call this FIRST when a task involves a page: the other browser tools take a `view_id` and this is where you learn it. " +
      "A view stays alive even when the browser panel is closed or the tab is switched away, so the page you need may already be open.",
    {},
    () => call(emit, () => ({ op: "list_views" }), formatTabs),
  );
}

export function buildBrowserReadTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_read",
    "Read the page loaded in an embedded browser view as a STRUCTURED SKELETON: outline, tables (headers + rows), " +
      "form fields (label / name / value / options), clickable elements, frames, and raw text. " +
      "Use this to read a page — do not probe the DOM with browser_eval first. " +
      "It reads the top document plus same-origin frames, and reaches into CROSS-ORIGIN frames too when the WebView2 " +
      "runtime allows it (so you do not have to navigate away to read an embedded prototype). Anything it could not " +
      "read is reported as such, with the reason. Hidden (display:none) tables/fields/clickables are skipped by default " +
      "and counted in a note — pass include_hidden to list them too (prototype pages that stack whole screens that way). " +
      "Raw text lists rendered text only; include_hidden applies to it too. " +
      "It does NOT run arbitrary script — use browser_eval for that.",
    { view_id: viewIdArg, include_hidden: includeHiddenArg },
    async (args) => {
          const projection = { includeHidden: args.include_hidden === true };
      try {
        const r = await runEval(buildProjectionScript(projection), { viewId: args.view_id }, emit);
        // runEval 的失败文本已是面向模型的（异常/不可序列化/桥失败各自不同），不加工。
        if (!r.ok) return textResult(r.error);
        // 骨架里若含**读不到的** iframe，再走一趟 CDP 做帧级读取（见 frames.ts）。
        // 不是失败——跨域 iframe 是浏览器的硬边界，CDP 是绕过去的那条路。
        const frameOutcome = await readFramesFromResult(args.view_id, r.value, projection, emit);
        return textResult(
          formatRead({ value: r.value, viewId: r.viewId, probe: r.probe }, frameOutcome),
        );
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser tool failed unexpectedly: ${detail}`);
      }
    },
  );
}

export function buildBrowserEvalTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_eval",
    "Run a JavaScript EXPRESSION in the page context of an embedded browser view and return its JSON-serialised result. " +
      "This is the escape hatch for anything browser_read does not cover: pulling a custom shape, inspecting one element, " +
      "filling a field, or answering a question about state the skeleton does not carry. " +
      "The last expression's value is what comes back, so end with something serialisable — return a small object, not the whole DOM. " +
      "The page carries the user's real logged-in session: only do what the user actually asked for, and never submit forms or " +
      "perform writes on their behalf without being asked.",
    {
      view_id: viewIdArg,
      script: z
        .string()
        .describe(
          // 「抛异常回 null」是 ExecuteScript 那条老通道的说法，已过时：CDP 路径（常态）把异常
          // 原文报回来（runEval"exception"分支）。写错会让模型以为"没报错 = 值为空"。
          "A JavaScript EXPRESSION; the last value comes back JSON-serialised. " +
            "A throw is reported to you as an error with its text (not as null). " +
            "Each call gets its own block scope: top-level let/const can be re-declared in a later call " +
            "(park values on `window` to carry them across calls). " +
            "Return objects directly — do not JSON.stringify them yourself.",
        ),
      frame: z
        .string()
        .optional()
        .describe(
          "Run the script inside a FRAME instead of the top document: pass a substring of that frame's URL " +
            "(browser_read lists them). Needed for cross-origin frames the top document cannot reach — " +
            "an embedded prototype, say.",
        ),
    },
    async (args) => {
          try {
        if (args.frame) {
          const outcome = await evalInFrame(args.view_id, args.frame, args.script, emit);
          return textResult(formatFrameEval(outcome));
        }
        const r = await runEval(args.script, { viewId: args.view_id, scoped: true }, emit);
        if (!r.ok) return textResult(r.error);
        return textResult(formatEval({ value: r.value, viewId: r.viewId, probe: r.probe }));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser tool failed unexpectedly: ${detail}`);
      }
    },
  );
}

/** `browser_act` 的入参（zod 推出来的形状）。 */
type ActArgs = {
  view_id?: string;
  action: "click" | "fill" | "hover" | "press";
  text?: string;
  selector?: string;
  tag?: string;
  index?: number;
  value?: string;
  key?: string;
  modifiers?: ("ctrl" | "shift" | "alt" | "meta")[];
};

/**
 * 入参守门：**本地就能判定的错，绝不发桥**（桥对面是桌面 Rust，发出去才发现参数不对要等 15s
 * 超时，而超时文案会把"你少给了 url/key"伪装成"浏览器卡了"）。返回 null = 放行。
 */
function validateActArgs(args: ActArgs): string | null {
  if (args.action === "press") {
    if (!args.key) {
      return (
        'action=press needs `key` — e.g. "Enter", "Escape", "Tab". ' +
        "Without a target the key goes to the element that currently has focus."
      );
    }
    return null;
  }
  // 非 press：目标必给，且 key/modifiers 属于 press——**明说，不静默忽略**。
  if (!args.selector && !args.text) {
    return "Give a target: either `text` (the visible label) or `selector` (CSS).";
  }
  if (args.key !== undefined || args.modifiers !== undefined) {
    return '`key` / `modifiers` only apply to action="press".';
  }
  if (args.action === "fill" && args.value === undefined) {
    return "action=fill needs `value`.";
  }
  return null;
}

/** 动作分发：一种动作一行（新增动作 = 这里加一条）。四种都回文本，故没有兜底分支。 */
async function runAct(
  args: ActArgs,
  target: ActTarget,
  emit: (e: ChatEvent) => void,
): Promise<string> {
  switch (args.action) {
    case "click":
      return performClick(args.view_id, target, emit);
    case "hover":
      return performHover(args.view_id, target, emit);
    case "fill":
      return performFill(args.view_id, target, String(args.value ?? ""), emit);
    case "press": {
      const raw = { key: args.key ?? "", modifiers: args.modifiers ?? [] };
      const stroke = resolveKey(raw.key, raw.modifiers);
      // 键名不认识 / 拿 press 打字：本地就拒（`keys.ts` 的文案已带上支持的键与下一步）。
      if (!stroke.ok) return stroke.error;
      return performPress(args.view_id, { target, stroke, raw }, emit);
    }
  }
}

export function buildBrowserActTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_act",
    "Perform an action on the page in an embedded browser view: click, fill, hover, or press a key. " +
      "Target the element by `text` (its visible label — preferred, e.g. the 刷新 button) or by a CSS `selector`. " +
      "This is how you move through a UI or fill a form. It does NOT submit anything by itself — submitting is a separate " +
      "click on the submit control, so only do that when the user asked for it. " +
      "Clicks use real CDP mouse input when the runtime supports it and fall back to synthetic events otherwise; " +
      "the result tells you which path was used — synthetic clicks may not drive every widget, so verify the page changed. " +
      "action=press sends a real key (Enter, Escape, Tab, …) to the focused element — after a `fill`, that is how you " +
      "commit a field whose framework submits on Enter or blur rather than on the value itself (note that Enter may " +
      "trigger the page's own submit handler: press it only when that is what you mean).",
    {
      view_id: viewIdArg,
      action: z
        .enum(["click", "fill", "hover", "press"])
        .describe(
          "click = mouse click; fill = set a field's value; hover = move the mouse over it (opens hover " +
            "menus/tooltips); press = send a real key to the focused element, or to `text`/`selector` when given",
        ),
      text: z.string().optional().describe("Visible label of the target (preferred). Most specific match wins."),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector for the target. Takes precedence over `text` when both are given. If it matches more " +
            "than one element, pass `index` — the tool will not guess which one you meant.",
        ),
      tag: z.string().optional().describe("Restrict text matching to one tag, e.g. 'button'. Only used with `text`."),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "When several elements match, pick this one. Required for a `selector` matching more than one element; " +
            "with `text`, default 0 = the most specific match.",
        ),
      value: z
        .string()
        .optional()
        .describe("Required for action=fill. For a <select>, pass either the option's value or its visible text."),
      key: z
        .string()
        .optional()
        .describe(
          "Key name for action=press: Enter, Escape, Tab, Space, Backspace, Delete, ArrowUp, ArrowDown, " +
            "ArrowLeft, ArrowRight, Home, End, PageUp, PageDown — or a single letter/digit combined with " +
            "`modifiers` (e.g. \"a\" with [\"ctrl\"]). To put text in a field use action=fill.",
        ),
      modifiers: z
        .array(z.enum(["ctrl", "shift", "alt", "meta"]))
        .optional()
        .describe('Only with action=press: modifiers to hold down (e.g. ["ctrl"] for Ctrl+A).'),
    },
    async (args) => {
          const bad = validateActArgs(args);
      if (bad) return textResult(bad);

      const target: ActTarget = {
        selector: args.selector,
        text: args.text,
        tag: args.tag,
        index: args.index,
      };
      try {
        return textResult(await runAct(args, target, emit));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser action failed unexpectedly: ${detail}`);
      }
    },
  );
}

/**
 * 截图块的说明文本。
 *
 * **不带任何可见性告警**：parking 之后不显示的视图照样合成，截图与前台视图同质
 * （探针实测同字节数）——没有需要预警的状态。
 *
 * `element` 是**裁剪**时的交代：不说，模型会把一张局部图当成整页（反过来更糟：以为拿到了
 * 局部而实际是整页，"只截这个按钮"就白说了）。
 */
function screenshotCaption(opts: { fullPage: boolean; format: ScreenshotFormat; element?: string }): string {
  const what = opts.element ? `of ${opts.element}` : opts.fullPage ? "page (full)" : "visible viewport";
  return (
    `Screenshot ${what} in the embedded browser as ${opts.format.toUpperCase()}. ` +
    `Reminder: this is the visual fallback — use browser_read / browser_eval when the question is ` +
    `about content or structure.`
  );
}

/**
 * 元素截图的目标：**判别式联合**，不是可选字段——可选字段会让"解析失败"与"没给 text"
 * 在类型上长得一样（本项目禁 `boolean | undefined` 假三态的同一款理由）。
 */
type ShotTarget = { ok: true; clip: ScreenshotClip; hit: string } | { ok: false; error: string };

/**
 * 元素截图的坐标解析：复用 `browser_act` 的解析脚本（**不写第二份元素定位**——判据分家正是
 * 这个仓库刚治过的病），取它的页面坐标矩形当 CDP 的 `clip`。
 *
 * 找不到 / 零尺寸 → **如实失败**，**不退化成整页截图**：用户明确说整页截图因上下文成本全程
 * 没用，退化会让模型以为拿到了局部。`scroll:false` 是为了**别动用户正在看的滚动位置**
 * （裁剪靠 `captureBeyondViewport`，不靠滚动）。
 */
async function resolveShotTarget(
  args: { view_id?: string; text?: string; selector?: string },
  emit: (e: ChatEvent) => void,
): Promise<ShotTarget> {
  const target: ActTarget = { selector: args.selector, text: args.text };
  const r = await runEval(buildResolveScript(target, { scroll: false }), { viewId: args.view_id }, emit);
  if (!r.ok) return { ok: false, error: r.error };

  const v = asRecord(r.value);
  // 不是对象与"页面上没这个元素"是两回事：前者要改的是脚本，后者要改的是词——混成一句会让
  // 模型拿着"找不到目标"的结论去换 text 重试（跟 act.ts 的 evalScript 同一款分流）。
  if (!v) return { ok: false, error: "The page script returned no usable object (it returned a non-object)." };
  if (v["ok"] !== true) return { ok: false, error: describeResolveFailure(v) };

  const rect = asRecord(v["rect"]);
  const clip = {
    x: Number(rect?.["x"]),
    y: Number(rect?.["y"]),
    width: Number(rect?.["w"]),
    height: Number(rect?.["h"]),
  };
  if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width < 1 || clip.height < 1) {
    return {
      ok: false,
      error: `Resolved the element but got no usable box to crop (${JSON.stringify(rect)}) — it may be zero-size.`,
    };
  }
  // 空标签要折成 "the element"：图标按钮（无文本、无 aria-label）正是这个功能最常指向的目标，
  // 而 labelOf 给的就是空串——空串不是 nullish，`??` 兜不住它，caption 会退成
  // "Screenshot visible viewport …"（把一次**裁剪**说成视口截图，说的还是错的那种）。
  const label = String(asRecord(v["hit"])?.["text"] ?? "").trim();
  // 命中多个时报数——同一个解析脚本、同一句注脚（`matchNote` 从 act.ts 导出），缺了它截图会
  // 悄悄按 index 0 裁一块，而 `browser_act` 那边却会说"命中了 N 个"。
  return { ok: true, clip, hit: (label || "the element") + matchNote(v) };
}

/**
 * 截图：agent 的**视觉兜底**。
 *
 * 描述里刻意反复申明"少用"——图像进上下文很贵，而读页面有结构化通道。它存在的理由是
 * 有一类问题 DOM 答不了：**用户此刻看到的到底是哪一块**（绝对定位堆叠的画布里，元素都在
 * DOM 里但只有一个面板可见）。2026-09-16 agent 实测提出这条需求。
 */
export function buildBrowserScreenshotTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_screenshot",
    "Take a screenshot of the embedded browser view. USE THIS SPARINGLY — it is the visual FALLBACK, not a way " +
      "to read a page: an image costs far more context than the structured read and gives you pixels instead of structure. " +
      "Reach for it when the question is genuinely visual — which panel is actually visible on screen, whether something " +
      "rendered at all, what a canvas or image-only region contains — or when the structured read came back empty and you " +
      "need to see why. It captures the visible viewport by default; pass full_page for the entire page, or pass `text` / " +
      "`selector` to crop the shot to a single element (cheapest — do that when one control is all you need). " +
      "It works on a parked view too — the page keeps rendering, so you do not need to bring it on screen first.",
    {
      view_id: viewIdArg,
      full_page: z
        .boolean()
        .optional()
        .describe(
          "Capture the whole page instead of just the visible viewport. Default false: the viewport is what the user " +
            "is actually looking at, and it costs less context. Ignored when `text` or `selector` is given (the crop wins).",
        ),
      text: z
        .string()
        .optional()
        .describe(
          "Crop the shot to this element's box, matched by its visible label (e.g. the 保存 button) — the " +
            "same matching browser_act uses, so it only reaches interactive elements; use `selector` for " +
            "anything else. Use this instead of a full screenshot when you only need one control.",
        ),
      selector: z
        .string()
        .optional()
        .describe("Crop to the element matching this CSS selector. Takes precedence over `text`."),
      format: z
        .enum(["jpeg", "png"])
        .optional()
        .describe(
          "Image format. Default 'jpeg' (quality 80) — much smaller than PNG, and a screenshot is re-sent in " +
            "every later turn. Use 'png' only for pixel-exact fidelity (fine text, thin lines).",
        ),
    },
    async (args) => {
          try {
        const fullPage = args.full_page === true;
        const format = args.format === "png" ? "png" : "jpeg";
        // 只有真的给了元素口径才去解析——没有 text/selector 的老路径一发都不多发。
        const target = args.text || args.selector ? await resolveShotTarget(args, emit) : null;
        if (target && !target.ok) return textResult(target.error);

        const shot = await captureScreenshot(
          args.view_id,
          { fullPage, format, clip: target?.ok === true ? target.clip : undefined },
          emit,
        );
        if (!shot.ok || !shot.data) return textResult(shot.error ?? "Screenshot failed.");
        return {
          content: [
            {
              type: "text" as const,
              text: screenshotCaption({ fullPage, format, element: target?.ok === true ? target.hit : undefined }),
            },
            { type: "image" as const, data: shot.data, mimeType: shot.mimeType ?? `image/${format}` },
          ],
        };
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser screenshot failed unexpectedly: ${detail}`);
      }
    },
  );
}

/**
 * `browser_wait`：**时序原语**。
 *
 * 存在的理由：`browser_act` 点完就返回，而"点了之后发生了什么"需要等待。没有这个工具时
 * agent 只能写一句 eval 手搓轮询——写进页面里的 `setTimeout` 在隐藏视图里会被降频，等待本身
 * 被冻住，超时变成假阴性。轮询跑在主机侧（`browser/wait.ts`）对这个病免疫。
 *
 * 它也是"合成点击降级后页面没变"那类抱怨的正解：真正的缺口不是 act 该自动断言（那会让
 * 「点了但本就不该变」变成假失败），而是**调用点需要能表达自己的期望**。
 */
export function buildBrowserWaitTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_wait",
    "Wait in an embedded browser view until something becomes true, then return. Use this after browser_act " +
      "when your next step depends on what the click triggered — do not hand-roll a polling loop with browser_eval. " +
      "TWO MODES. `until:\"condition\"` (default) polls a JavaScript EXPRESSION you give; a truthy value means done. " +
      "The expression must be SYNCHRONOUS and it may throw while the thing you are waiting for does not exist yet " +
      "(that is treated as not-yet-true, not as a failure). `until:\"load\"` waits for the view to finish loading, " +
      "which no in-page expression can express (document.readyState is answered by the OLD document during a " +
      "navigation). A timeout is REPORTED, not raised: you get how many times it polled and the last value it saw — " +
      "read that before concluding the page is broken.",
    {
      view_id: viewIdArg,
      until: z
        .enum(["condition", "load"])
        .optional()
        .describe("condition (default) = poll `condition`; load = wait for the view to finish a navigation."),
      condition: z
        .string()
        .optional()
        .describe(
          "Required when until=condition. A synchronous JS expression in the page; truthy = satisfied. " +
            "It may throw while the target does not exist yet — that counts as not-yet-true.",
        ),
      timeout_ms: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          `How long to wait, default ${WAIT_TIMEOUT_DEFAULT_MS}. Capped at ${WAIT_TIMEOUT_MAX_MS} — treat a timeout ` +
            `as "did not happen within the budget", not as "will never happen".`,
        ),
      interval_ms: z
        .number()
        .int()
        .min(WAIT_INTERVAL_MIN_MS)
        .optional()
        .describe(`Poll interval, default ${WAIT_INTERVAL_DEFAULT_MS}. Polling happens on the host, not in the page.`),
    },
    async (args) => {
    
      const mode = args.until === "load" ? "load" : "condition";
      if (mode === "condition" && !args.condition) {
        return textResult(
          "until=condition needs `condition` — a JavaScript EXPRESSION whose truthy value means done. " +
            "If you meant to wait for a navigation to finish, pass until=\"load\" instead.",
        );
      }
      try {
        return textResult(
          await waitForBrowser(
            {
              viewId: args.view_id,
              mode,
              condition: args.condition,
              timeoutMs: Math.min(args.timeout_ms ?? WAIT_TIMEOUT_DEFAULT_MS, WAIT_TIMEOUT_MAX_MS),
              intervalMs: args.interval_ms ?? WAIT_INTERVAL_DEFAULT_MS,
            },
            emit,
          ),
        );
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser wait failed unexpectedly: ${detail}`);
      }
    },
  );
}

/**
 * tab 级动作：**自己开一个 tab**、关掉它、导航、推到用户眼前。
 *
 * 与 `browser_act` 的分工：那是**页面里**的动作（点/填/悬停），这是**标签页**的动作。
 * 收在一个工具里而不是散成五个——每加一个工具就是每轮请求多一份 schema。
 */
export function buildBrowserTabTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_tab",
    "Open, close, navigate or show a tab in the embedded browser (a view) — the tab-level " +
      "companion to browser_tabs / browser_act. " +
      "action=open creates a view OF YOUR OWN and returns its view_id: use that id for every " +
      "later call. The view is created PARKED — the page runs in the background (rendering, " +
      "timers, navigation and screenshots all work) and the user's panel is not disturbed, so " +
      "you can keep working while they look at something else. " +
      "action=close destroys a view — do it when you are done: parked views keep rendering. " +
      "action=focus asks the panel to bring a view to the front, which STEALS what the user is " +
      "looking at; use it only when they should actually look at the page. " +
      "WHEN SEVERAL VIEWS EXIST always pass the view_id you got from action=open — the other " +
      "tools refuse to guess (omitting it fails rather than acting on the wrong tab).",
    {
      action: z
        .enum(["open", "close", "navigate", "back", "forward", "focus"])
        .describe(
          "open = create a parked view of your own (returns view_id); close = destroy a view; " +
            "navigate / back / forward = move it through history; focus = ask the user's panel " +
            "to show it.",
        ),
      url: z
        .string()
        .optional()
        .describe("Required for action=open and action=navigate. Bare hosts are not normalised here."),
      label: z
        .string()
        .optional()
        .describe(
          "Only for action=open: a short name shown on the tab until the page's own title is " +
            "known (e.g. 'vue-admin dev'). Use it when several tabs point at the same dev server.",
        ),
      view_id: z
        .string()
        .optional()
        .describe(
          "Target view (from browser_tabs, or the id open returned). Omit only when one view exists.",
        ),
    },
    async (args) => {
          try {
        return textResult(
          await performTabAction(
            args.action,
            { url: args.url, label: args.label, viewId: args.view_id },
            emit,
          ),
        );
      } catch (e) {
        // 参数不全（buildTabCall 抛）与桥侧异常都折成文本——**永不抛**是本模块的红线。
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`browser_tab failed: ${detail}`);
      }
    },
  );
}

/** 网络缓冲一次读回多少条（缺省）与其上限。上限 = recorder 的环形缓冲 cap，要全部就是它。 */
const NETWORK_LIMIT_DEFAULT = 20;
const NETWORK_LIMIT_MAX = 100;

/**
 * `browser_network`：**页面自己发过什么**（XHR/fetch 的方法/URL/状态/耗时/响应片段）。
 *
 * 与 `browser_read` 的分工：那是"页面上有什么"，这是"页面做了什么"——空白页、点了没反应、
 * 被前端吞掉的 500，答案都在请求里而不在 DOM 里。
 *
 * 读数**不新增通道**：一次 `Runtime.evaluate` 读 recorder 的环形缓冲（见 `browser/recorder.ts`）。
 * 缓冲活在**当前文档**上，导航即清零——所以"这次才装上"必须如实说（`armedBefore`）。
 */
export function buildBrowserNetworkTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_network",
    "List the XHR/fetch requests the page has made — method, URL, status, duration and a clipped response body, " +
      "newest last. This is how you answer \"what did that request actually return?\": a blank page, an action that " +
      "never advanced, a 500 behind a swallowed error. Unfinished requests show as pending. The recorder is installed " +
      "on demand and lives in the CURRENT document only (it is cleared by any navigation); if this call installs it, " +
      "a note says so — navigate or reload to capture a fresh load from its first request. " +
      "Use browser_console for console messages and uncaught errors.",
    {
      view_id: viewIdArg,
      filter: z.string().optional().describe("Only requests whose URL contains this substring. Omit for all."),
      limit: z.number().int().min(1).max(NETWORK_LIMIT_MAX).optional()
        .describe(`How many of the most recent requests to show (default ${NETWORK_LIMIT_DEFAULT}, max ${NETWORK_LIMIT_MAX}).`),
    },
    async (args) => {
          try {
        const r = await readRecorder(
          { kind: "reqs", limit: args.limit ?? NETWORK_LIMIT_DEFAULT, match: args.filter },
          args.view_id,
          emit,
        );
        if (!r.ok) return textResult(r.error);
        return textResult(renderNetwork(r.value, {
          filter: args.filter,
          registered: r.registered,
          registerError: r.registerError,
        }));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser tool failed unexpectedly: ${detail}`);
      }
    },
  );
}

/** console 缓冲一次读回多少条（缺省）与其上限。上限 = recorder 的环形缓冲 cap，要全部就是它。 */
const CONSOLE_LIMIT_DEFAULT = 30;
const CONSOLE_LIMIT_MAX = 100;

/**
 * `browser_console`：**页面往控制台说了什么**（`console.*` + 页面没接住的错误）。
 *
 * 与 `browser_network` 的分工：那是"页面向外发了什么"，这是"页面自己报了/没报什么"。前端把
 * 一个 500 吞进自己的 `try/catch` 时，请求侧还能看见，错误侧只剩这里——`uncaught` /
 * `unhandled` 与 `console.error` **分开显示**就是为它（合成一类就把"谁没接住"抹掉了）。
 *
 * 读数与缓冲规则同 `browser_network`（见其注释）：一次求值读同一只环形缓冲，缓冲只活在
 * **当前文档**上，所以"这次才装上"必须如实说（`armedBefore`）。
 */
export function buildBrowserConsoleTool(
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_console",
    "List what the page logged: console.* calls AND the errors it never caught (uncaught exceptions, unhandled promise " +
      "rejections — shown separately, because those are exactly the ones the page's own error handling did not swallow). " +
      "Reach for it when something failed silently — an API error caught by the app and never surfaced, a blank panel. " +
      "Same buffer rules as browser_network: it lives in the CURRENT document only and a call that has to install the " +
      "recorder first says so.",
    {
      view_id: viewIdArg,
      level: z
        .enum(["error", "warn", "all"])
        .optional()
        .describe(
          "error = console.error plus uncaught exceptions and unhandled rejections; warn = console.warn only; " +
            "all (default) = everything.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(CONSOLE_LIMIT_MAX)
        .optional()
        .describe(`How many of the most recent entries to show (default ${CONSOLE_LIMIT_DEFAULT}, max ${CONSOLE_LIMIT_MAX}).`),
    },
    async (args) => {
          try {
        const level = args.level ?? "all";
        const r = await readRecorder(
          { kind: "logs", limit: args.limit ?? CONSOLE_LIMIT_DEFAULT, match: level },
          args.view_id,
          emit,
        );
        if (!r.ok) return textResult(r.error);
        return textResult(renderConsole(r.value, {
          level,
          registered: r.registered,
          registerError: r.registerError,
        }));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser tool failed unexpectedly: ${detail}`);
      }
    },
  );
}

/** 工具总装：上层只需读这张表。新增工具 = 这里加一项（并同步 browserMcp 的规则与前端镜像）。 */
export function buildBrowserTools(emit: (e: ChatEvent) => void) {
  return [
    buildBrowserTabsTool(emit),
    buildBrowserReadTool(emit),
    buildBrowserActTool(emit),
    buildBrowserWaitTool(emit),
    buildBrowserEvalTool(emit),
    buildBrowserScreenshotTool(emit),
    buildBrowserTabTool(emit),
    buildBrowserNetworkTool(emit),
    buildBrowserConsoleTool(emit),
  ];
}
