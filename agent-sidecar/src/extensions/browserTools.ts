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
import { PAGE_PROJECTION_SCRIPT } from "./browser/projection.js";
import { performClick, performFill, performHover } from "./browser/act.js";
import { evalInFrame, readFramesFromResult } from "./browser/frames.js";
import { captureScreenshot } from "./browser/screenshot.js";
import type { ActTarget } from "./browser/actions.js";
import {
  NO_BROWSER_HOST_TEXT,
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
 * headless 宿主**结构性**没有内嵌浏览器（不是暂时不可用）。
 *
 * 必须在**发起前**短路：桥的对面是桌面 Rust，headless 没有回包方，发出去只会白等 15s 超时，
 * 而超时文案会把「本环境没这个能力」伪装成「浏览器卡了」。
 */
function hasBrowserHost(env: NodeJS.ProcessEnv): boolean {
  return env.AIDE_HEADLESS !== "1";
}

/**
 * 工具公共壳：host 短路 → 发桥 → 失败转文本 → 成功走格式化器。
 * **永不抛**（MCP 会把抛出的 handler 变成 isError，是本模块的红线）。
 */
async function call(
  env: NodeJS.ProcessEnv,
  emit: (e: ChatEvent) => void,
  makeCall: () => BrowserCall,
  render: (data: unknown) => string,
): Promise<ToolResult> {
  if (!hasBrowserHost(env)) return textResult(NO_BROWSER_HOST_TEXT);
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

/** 各工具共用的 `view_id` 参数：缺省时由 Rust 侧按「唯一可见 → 唯一存在」解析。 */
const viewIdArg = z
  .string()
  .optional()
  .describe(
    "Target browser view id (from browser_tabs). Omit when exactly one view is open; " +
      "if it is ambiguous the call fails and lists the open views.",
  );

export function buildBrowserTabsTool(
  env: NodeJS.ProcessEnv,
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_tabs",
    "List the browser views (tabs) currently open in Aide's embedded browser, with each one's id, url, title and visibility. " +
      "Call this FIRST when a task involves a page: the other browser tools take a `view_id` and this is where you learn it. " +
      "A view stays alive even when the browser panel is closed or the tab is switched away, so the page you need may already be open.",
    {},
    () => call(env, emit, () => ({ op: "list_views" }), formatTabs),
  );
}

export function buildBrowserReadTool(
  env: NodeJS.ProcessEnv,
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_read",
    "Read the page loaded in an embedded browser view as a STRUCTURED SKELETON: outline, tables (headers + rows), " +
      "form fields (label / name / value / options), clickable elements, frames, and raw text. " +
      "Use this to read a page — do not probe the DOM with browser_eval first. " +
      "It reads the top document plus same-origin frames, and reaches into CROSS-ORIGIN frames too when the WebView2 " +
      "runtime allows it (so you do not have to navigate away to read an embedded prototype). Anything it could not " +
      "read is reported as such, with the reason. It does NOT run arbitrary script — use browser_eval for that.",
    { view_id: viewIdArg },
    async (args) => {
      if (!hasBrowserHost(env)) return textResult(NO_BROWSER_HOST_TEXT);
      try {
        const resp = await queryBrowser(
          { op: "eval", view_id: args.view_id, script: PAGE_PROJECTION_SCRIPT },
          emit,
        );
        if (!resp.ok) return textResult(formatBridgeFailure(resp));
        // 骨架里若含**读不到的** iframe，再走一趟 CDP 做帧级读取（见 frames.ts）。
        // 不是失败——跨域 iframe 是浏览器的硬边界，CDP 是绕过去的那条路。
        const frameOutcome = await readFramesFromResult(args.view_id, resp.data, emit);
        return textResult(formatRead(resp.data, frameOutcome));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser tool failed unexpectedly: ${detail}`);
      }
    },
  );
}

export function buildBrowserEvalTool(
  env: NodeJS.ProcessEnv,
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
          "JavaScript expression evaluated in the page. The value of the last expression is JSON-serialised back to you. " +
            "Throw inside your script and the result is null — return {ok:false, error} yourself if you need to report failure.",
        ),
      frame: z
        .string()
        .optional()
        .describe(
          "Run the script inside a FRAME of the page instead of the top document. Pass a substring of the frame's URL " +
            "(browser_read lists them under 'Frames'). Use this when the content you need lives in a cross-origin frame " +
            "that the top document cannot reach — an embedded prototype, for example.",
        ),
    },
    async (args) => {
      if (!hasBrowserHost(env)) return textResult(NO_BROWSER_HOST_TEXT);
      try {
        if (args.frame) {
          const outcome = await evalInFrame(args.view_id, args.frame, args.script, emit);
          return textResult(formatFrameEval(outcome));
        }
        const resp = await queryBrowser(
          { op: "eval", view_id: args.view_id, script: args.script },
          emit,
        );
        if (!resp.ok) return textResult(formatBridgeFailure(resp));
        return textResult(formatEval(resp.data));
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser tool failed unexpectedly: ${detail}`);
      }
    },
  );
}

export function buildBrowserActTool(
  env: NodeJS.ProcessEnv,
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_act",
    "Perform an action on the page in an embedded browser view: click, fill, or hover an element. " +
      "Target the element by `text` (its visible label — preferred, e.g. the 刷新 button) or by a CSS `selector`. " +
      "This is how you move through a UI or fill a form. It does NOT submit anything by itself — submitting is a separate " +
      "click on the submit control, so only do that when the user asked for it. " +
      "Clicks use real CDP mouse input when the runtime supports it and fall back to synthetic events otherwise; " +
      "the result tells you which path was used — synthetic clicks may not drive every widget, so verify the page changed.",
    {
      view_id: viewIdArg,
      action: z
        .enum(["click", "fill", "hover"])
        .describe("click = mouse click; fill = set a field's value; hover = move the mouse over it (opens hover menus/tooltips)"),
      text: z.string().optional().describe("Visible label of the target (preferred). Most specific match wins."),
      selector: z.string().optional().describe("CSS selector for the target. Takes precedence over `text` when both are given."),
      tag: z.string().optional().describe("Restrict text matching to one tag, e.g. 'button'. Only used with `text`."),
      index: z.number().int().min(0).optional().describe("When several elements match, pick this one (default 0 = the most specific)."),
      value: z
        .string()
        .optional()
        .describe("Required for action=fill. For a <select>, pass either the option's value or its visible text."),
    },
    async (args) => {
      if (!hasBrowserHost(env)) return textResult(NO_BROWSER_HOST_TEXT);
      const target: ActTarget = {
        selector: args.selector,
        text: args.text,
        tag: args.tag,
        index: args.index,
      };
      if (!target.selector && !target.text) {
        return textResult("Give a target: either `text` (the visible label) or `selector` (CSS).");
      }
      if (args.action === "fill" && args.value === undefined) {
        return textResult("action=fill needs `value`.");
      }
      try {
        switch (args.action) {
          case "click":
            return textResult(await performClick(args.view_id, target, emit));
          case "hover":
            return textResult(await performHover(args.view_id, target, emit));
          case "fill":
            return textResult(await performFill(args.view_id, target, String(args.value), emit));
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        return textResult(`Browser action failed unexpectedly: ${detail}`);
      }
    },
  );
}

/**
 * 截图：agent 的**视觉兜底**。
 *
 * 描述里刻意反复申明"少用"——图像进上下文很贵，而读页面有结构化通道。它存在的理由是
 * 有一类问题 DOM 答不了：**用户此刻看到的到底是哪一块**（绝对定位堆叠的画布里，元素都在
 * DOM 里但只有一个面板可见）。2026-09-16 agent 实测提出这条需求。
 */
export function buildBrowserScreenshotTool(
  env: NodeJS.ProcessEnv,
  emit: (e: ChatEvent) => void,
) {
  return tool(
    "browser_screenshot",
    "Take a screenshot of the embedded browser view. USE THIS SPARINGLY — it is the visual FALLBACK, not a way " +
      "to read a page: an image costs far more context than the structured read and gives you pixels instead of structure. " +
      "Reach for it when the question is genuinely visual — which panel is actually visible on screen, whether something " +
      "rendered at all, what a canvas or image-only region contains — or when the structured read came back empty and you " +
      "need to see why. It captures the visible viewport by default; pass full_page for the entire page.",
    {
      view_id: viewIdArg,
      full_page: z
        .boolean()
        .optional()
        .describe(
          "Capture the whole page instead of just the visible viewport. Default false: the viewport is what the user " +
            "is actually looking at, and it costs less context.",
        ),
      format: z
        .enum(["jpeg", "png"])
        .optional()
        .describe(
          "Image format. Default 'jpeg' (quality 80): several times smaller than PNG, which matters because a " +
            "screenshot lands in the conversation history and is re-sent on later turns. Ask for 'png' only when you " +
            "need pixel-exact fidelity — fine text, thin lines, exact colours.",
        ),
    },
    async (args) => {
      if (!hasBrowserHost(env)) return textResult(NO_BROWSER_HOST_TEXT);
      try {
        const fullPage = args.full_page === true;
        const format = args.format === "png" ? "png" : "jpeg";
        const shot = await captureScreenshot(args.view_id, { fullPage, format }, emit);
        if (!shot.ok || !shot.data) return textResult(shot.error ?? "Screenshot failed.");
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Screenshot of the embedded browser ${fullPage ? "page (full)" : "visible viewport"} as ${format.toUpperCase()}. ` +
                `Reminder: this is the visual fallback — use browser_read / browser_eval when the question is about content or structure.`,
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

/** 工具总装：上层只需读这张表。新增工具 = 这里加一项（并同步 browserMcp 的规则与前端镜像）。 */
export function buildBrowserTools(env: NodeJS.ProcessEnv, emit: (e: ChatEvent) => void) {
  return [
    buildBrowserTabsTool(env, emit),
    buildBrowserReadTool(env, emit),
    buildBrowserActTool(env, emit),
    buildBrowserEvalTool(env, emit),
    buildBrowserScreenshotTool(env, emit),
  ];
}
