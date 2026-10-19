// aide-computer 的工具定义：让 agent 像人一样操作用户的电脑（Windows 桌面）。
//
// **工具面里永远不出现应用名词**——「某个应用怎么用」不是这里的能力。验收尺：换一个应用，本文件一行不动。
// 权限：读 / 等三个工具自动放行；做动作的两个走权限流程（见 computerMcp.ts）。
// 设计：docs/superpowers/specs/2026-10-19-computer-use-design.md
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent } from "../engine/types.js";
import { queryComputer, type ComputerCall } from "./computer/client.js";
import {
  formatAct,
  formatRead,
  formatWait,
  formatWindowAction,
  formatWindows,
  screenshotOf,
} from "./computer/format.js";

type ImageBlock = { type: "image"; data: string; mimeType: string };
// 必须是 type 别名而非 interface（SDK 的 CallToolResult 带索引签名，见 browserTools.ts 的注释）。
type ToolResult = { content: ({ type: "text"; text: string } | ImageBlock)[] };
type Emit = (e: ChatEvent) => void;

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/** 公共壳：发桥 → 失败转文本 → 成功走格式化器。**永不抛**。 */
async function call(emit: Emit, c: ComputerCall, render: (data: unknown) => ToolResult): Promise<ToolResult> {
  try {
    const resp = await queryComputer(c, emit);
    if (!resp.ok) return textResult(resp.error ?? "The computer-use executor failed without a message.");
    return render(resp.data);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return textResult(`Computer tool failed unexpectedly: ${detail}`);
  }
}

const text = (f: (d: unknown) => string) => (d: unknown) => textResult(f(d));

const windowIdArg = z.string().describe("Window id from computer_windows (e.g. \"0x4E0726\").");

const targetSchema = z
  .union([
    z.object({ ref: z.string().describe("Element ref from the latest computer_read, e.g. \"e12\".") }),
    z.object({
      name: z.string().describe("Visible name of the element; must match exactly one element."),
      role: z.string().optional().describe("Control type to disambiguate, e.g. Button, Edit, ListItem."),
    }),
    z.object({
      x: z.number(),
      y: z.number(),
      obs: z.number().describe("The obs of the screenshot these image-pixel coordinates come from."),
    }),
  ])
  .describe("What to act on: {ref} (preferred), {name, role?}, or {x, y, obs} from a screenshot.");

const stepSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("click"), target: targetSchema }),
  z.object({ do: z.literal("double_click"), target: targetSchema }),
  z.object({ do: z.literal("right_click"), target: targetSchema }),
  z.object({
    do: z.literal("type"),
    text: z.string().describe("Typed exactly as given; a newline is the Enter key."),
    target: targetSchema.optional().describe("Focus this element first; omit to type into whatever has focus."),
  }),
  z.object({ do: z.literal("press"), keys: z.string().describe("One key or combination: \"enter\", \"ctrl+s\", \"alt+f4\", \"shift+tab\".") }),
  z.object({
    do: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(30).optional().describe("Wheel notches, default 3."),
    target: targetSchema.optional().describe("Scroll over this element; omit for the window's center."),
  }),
  z.object({ do: z.literal("set_value"), target: targetSchema, value: z.string() }),
]);

const conditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("window_appears"),
    title: z.string().optional().describe("Part of the title."),
    process: z.string().optional().describe("Part of the process name."),
  }),
  z.object({ kind: z.literal("window_gone") }),
  z.object({ kind: z.literal("element_appears"), name: z.string(), role: z.string().optional() }),
  z.object({ kind: z.literal("element_gone"), name: z.string(), role: z.string().optional() }),
  z.object({ kind: z.literal("text_contains"), text: z.string() }),
  z.object({
    kind: z.literal("text_stable"),
    quiet_ms: z.number().int().min(300).max(20_000).optional().describe("How long the window must stay unchanged, default 1500."),
  }),
  z.object({ kind: z.literal("focus_changes") }),
]);

export function buildComputerTools(emit: Emit) {
  return [
    tool(
      "computer_windows",
      "List the windows open on the user's computer: id, title, process, and whether each is in the " +
        "foreground, minimized, or runs as administrator (those cannot be operated). Start here.",
      {},
      () => call(emit, { op: "windows" }, text(formatWindows)),
    ),
    tool(
      "computer_read",
      "Look at a window: its controls as an indented list, each with a ref like [e12] to act on, plus " +
        "values, states (focused, disabled, checked, selected, expanded…) and the text of documents and " +
        "terminals. Returns an `obs` number. Refs stay the same for the same control across reads. " +
        "Ask for a screenshot only when the list does not show what you need — an image costs far more context.",
      {
        window_id: windowIdArg.optional().describe("Omit for the foreground window."),
        screenshot: z.boolean().optional().describe("Also attach an image of the window. Default false."),
        scope: z
          .string()
          .optional()
          .describe(
            "Ref of a container (list, panel, dialog body) from the latest read: list only what is inside it. " +
              "Use it when a read is truncated. It sticks for this window's change reports until you read without scope.",
          ),
        text_tail: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("For documents/terminals: return the last N lines of the whole buffer instead of only the visible part."),
      },
      (args) =>
        call(emit, { op: "read", ...args }, (data) => {
          const res = textResult(formatRead(data));
          const png = screenshotOf(data);
          if (png) res.content.push({ type: "image", data: png, mimeType: "image/png" });
          return res;
        }),
    ),
    tool(
      "computer_act",
      "Do a short series of steps (1–8) in one window with the real mouse and keyboard: click, double_click, " +
        "right_click, type, press, scroll, set_value. Before every step it checks that the target is still " +
        "there and stops at the first step whose target changed. The result reports each executed step and " +
        "what changed afterwards (new or closed windows, focus, added/removed/changed controls) — read it " +
        "before the next action. Executed means sent, not that it achieved the goal.",
      {
        window_id: windowIdArg,
        intent: z.string().describe("One sentence on what these steps are meant to achieve (shown to the user for approval)."),
        steps: z.array(stepSchema).min(1).max(8),
      },
      (args) => call(emit, { op: "act", ...args }, text(formatAct)),
    ),
    tool(
      "computer_wait",
      "Wait, without spending turns, until something happens: a window appears or goes away, an element " +
        "appears or goes away, some text shows up, a window's content stops changing (text_stable — for " +
        "something still producing output), or the focus changes. Returns when met or on timeout (default " +
        "10 s, max 60 s), with what changed.",
      {
        window_id: windowIdArg.optional().describe("Window to watch; omit for the foreground window. Not needed for window_appears."),
        condition: conditionSchema,
        timeout_ms: z.number().int().min(100).max(60_000).optional(),
      },
      (args) => call(emit, { op: "wait", ...args }, text(formatWait)),
    ),
    tool(
      "computer_window",
      "Window-level actions: launch an application by the name shown in the Start menu (or an executable " +
        "like notepad.exe) and get its new window; focus, minimize, maximize, restore or close a window.",
      {
        action: z.enum(["launch", "focus", "minimize", "maximize", "restore", "close"]),
        app: z.string().optional().describe("For launch: the application's name."),
        window_id: windowIdArg.optional().describe("For every action except launch."),
      },
      (args) => call(emit, { op: "window", ...args }, text(formatWindowAction)),
    ),
  ];
}
