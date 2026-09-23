/**
 * `browser_console` 的渲染：`logs[]` → 紧凑行。
 *
 * 一条硬约定：**`uncaught` / `unhandled` 必须与 `console.error` 分开显示**。它们不是"页面主动
 * 打印的错误"，而是页面**没接住**的错误——反馈里的现场（后端返回 `No enum constant …` 被前端
 * try/catch 吞掉）正是这一类。合成一行 `[error]` 就把"谁吞了它"这条线索抹掉了。
 */
import { asArray, asRecord, pad, str } from "./format.js";

/** 级别标签的**总宽度**（含方括号）——对齐是为了让模型一眼扫列。 */
const LEVEL_WIDTH = 11;

/** 渲染选项：级别过滤（表头要说）、注册结果（失败要说）。 */
export interface ConsoleNotes {
  level?: string;
  registered: boolean;
  registerError?: string;
}

/**
 * 级别标签 + **一个分隔空格**，再补齐到列宽。
 *
 * 空格写在 `pad` **里侧**：「unhandled」正好 9 字母，`[unhandled]` = 11 = 列宽本身，靠 `pad`
 * 补出分隔是不行的（`padEnd` 到点就停），正文会贴着标签出来——`[unhandled]Unhandled promise…`。
 * 而这正是本批最要紧的两类之一。`[error]    ` / `[warn]     ` 因此在 `]` 后仍是四个/五个空格
 * （分隔那一个含在内），与 spec §8.2 的样张逐字一致。`[unhandled] ` 会超宽一格：`pad` 不截断
 * （`format.ts` 的 house rule），宁可错一格也不吃掉内容。
 */
function levelTag(lvl: string): string {
  return pad(`[${lvl || "?"}] `, LEVEL_WIDTH);
}

/** 表头：说清窗口与过滤（`error` 的语义含 uncaught/unhandled，表头照实写）。 */
function header(value: Record<string, unknown>, level: string | undefined): string {
  const shown = asArray(value["items"]).length;
  const matched = Number(value["matched"]) || 0;
  const total = Number(value["total"]) || 0;
  if (!level || level === "all") return `Console (last ${shown} of ${total}):`;
  return `Console (${level} only, last ${shown} of ${matched} matches, ${total} total):`;
}

/** 旁注：这次才装上 / 注册失败（都不许静默）。 */
function notesText(value: Record<string, unknown>, notes: ConsoleNotes): string[] {
  const out: string[] = [];
  if (value["armedBefore"] !== true) {
    out.push(
      "NOTE: the recorder was armed in this document by this call, so anything the page logged before now " +
        "is not in the buffer. Reload or navigate to capture a fresh document from its first line.",
    );
  }
  if (!notes.registered && notes.registerError) out.push(`NOTE: ${notes.registerError}`);
  return out;
}

/** 三种空必须可辨：这次才装 / 装了但页面没写过 / 有记录但全被级别滤掉。 */
function emptyText(value: Record<string, unknown>, notes: ConsoleNotes): string {
  if (value["armedBefore"] !== true) return "Nothing recorded yet.";
  const total = Number(value["total"]) || 0;
  if (total > 0) return `${total} entries recorded, none at level ${JSON.stringify(notes.level ?? "")}.`;
  return "Nothing has been written to the console since the recorder was armed — no console.* call and no uncaught error.";
}

/** 一行：级别标签 + 文本 +（截断时）原始长度。 */
function renderLine(item: Record<string, unknown>): string {
  const suffix = item["cut"] === true ? `…(${Number(item["len"]) || 0} chars)` : "";
  return `${levelTag(str(item["lvl"]))}${str(item["text"])}${suffix}`;
}

/** 渲染。**永不抛**：入参是 `unknown`，逐字段判型。 */
export function renderConsole(value: unknown, notes: ConsoleNotes): string {
  const v = asRecord(value) ?? {};
  const items = asArray(v["items"]).map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
  const head = header(v, notes.level);
  const tail = notesText(v, notes);
  if (!items.length) return [head, emptyText(v, notes), ...tail].filter(Boolean).join("\n");
  return [head, ...items.map(renderLine), ...tail].join("\n");
}
