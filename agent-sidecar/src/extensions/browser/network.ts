/**
 * `browser_network` 的渲染：`reqs[]` → 紧凑行。
 *
 * 形态由反馈决定：「紧凑地贴表格行」正是 agent 说 `browser_eval` 好用的理由，所以一条请求一行，
 * 不摊平成多段。三条硬约定（都来自实测痛点）：
 * - **未结束要看得出来**（`(pending, Nms so far)`）——"审批没推进"经常就是卡在一条永不返回的请求上；
 * - **失败前置一行摘要**——agent 十次里有九次是冲着失败来的；
 * - **没读到的东西如实说**（截断 / 无状态码 / 这次才装上 / 注册失败），不静默。
 */
import { asArray, asRecord, pad, str } from "./format.js";

/** 方法列的宽度——`GET ` 与 `POST` 因此同宽，URL 对齐成一列（扫列比扫行快）。 */
const METHOD_WIDTH = 4;

/** 渲染选项：过滤串（表头要说）、注册结果（失败要说）。 */
export interface NetworkNotes {
  filter?: string;
  registered: boolean;
  registerError?: string;
}

/**
 * 一行请求。字段缺失一律按"可能缺"写，**永不抛**（格式化器铁律）。
 *
 * 耗时列只在**已结束**的条目上出现：pending 那一行的状态列自己就写着 `(pending, Nms so far)`，
 * 再印一遍是同一个数字说两次（同一份事实两个来源，早晚会说岔）。
 */
function renderRow(item: Record<string, unknown>, n: number): string {
  const method = pad(str(item["method"]) || "?", METHOD_WIDTH);
  const url = str(item["url"]) || "(no url)";
  const ms = Number(item["ms"]);
  const timing = item["done"] === true ? `  ${Number.isFinite(ms) ? `${Math.round(ms)}ms` : "?ms"}` : "";
  return `#${n} ${method} ${url}  → ${statusText(item)}${timing}${bodyText(item)}`;
}

/** 状态那一列：pending / 真状态码 / 没有状态码（CORS、中止、未结束），三者不许混。 */
function statusText(item: Record<string, unknown>): string {
  if (item["done"] !== true) return `(pending, ${Math.round(Number(item["ms"]) || 0)}ms so far)`;
  const status = Number(item["status"]);
  if (Number.isFinite(status) && status > 0) return String(status);
  return item["err"] ? "(failed)" : "(no status code)";
}

/** 响应体片段（含截断标记与失败原因）。 */
function bodyText(item: Record<string, unknown>): string {
  const bits: string[] = [];
  const body = str(item["body"]);
  if (body) bits.push(item["bodyCut"] === true ? `${body}…(${Number(item["bodyLen"]) || 0} chars)` : body);
  const err = str(item["err"]);
  if (err) bits.push(err);
  return bits.length ? `  ${bits.join("  ")}` : "";
}

/** 表头：说清窗口（取了最近多少条 / 匹配多少 / 总共多少）。 */
function header(value: Record<string, unknown>, filter: string | undefined): string {
  const shown = asArray(value["items"]).length;
  const matched = Number(value["matched"]) || 0;
  const total = Number(value["total"]) || 0;
  if (!filter) return `Network requests (last ${shown} of ${total}, newest last):`;
  return `Network requests matching ${JSON.stringify(filter)} (last ${shown} of ${matched} matches, ${total} total, newest last):`;
}

/**
 * 匹配了多少条。`matched` 缺失时按"窗口就是全部"算——与 `windowStart` 同一套兜底，
 * 否则两个调用点会各写各的 fallback，`matched` 一缺就悄悄走岔（`from` 变负、行号从 1 起）。
 */
function matchedCount(value: Record<string, unknown>): number {
  return Number(value["matched"]) || asArray(value["items"]).length;
}

/** 窗口起点在**匹配序列**里的位次（1 基）。行号与失败摘要的"在不在下面这段里"都用它。 */
function windowStart(value: Record<string, unknown>): number {
  return matchedCount(value) - asArray(value["items"]).length + 1;
}

/** 失败摘要行：只统计**已结束**的请求（pending 不是失败）。 */
function failureLine(value: Record<string, unknown>, filter: string | undefined): string | null {
  const failed = asRecord(value["failed"]);
  const n = Number(failed?.["n"]) || 0;
  if (n <= 0) return null;
  const first = Number(failed?.["first"]);
  // 分母必须与分子同口径：`failed.n` 是在**匹配序列**上数出来的（recorder 读脚本），
  // 带 filter 时报 "of total" 会把几十条从没看过的请求写进结论里——正是本特性要防的那种误读。
  const scope = filter ? `${matchedCount(value)} matches` : `${Number(value["total"]) || 0}`;
  const where = first < windowStart(value) ? ` #${first} (not in the window below)` : ` #${first}`;
  return `⚠ ${n} of ${scope} failed — first failure${where}`;
}

/** 旁注：这次才装上 / 注册失败（都不许静默）。 */
function notesText(value: Record<string, unknown>, notes: NetworkNotes): string[] {
  const out: string[] = [];
  if (value["armedBefore"] !== true) {
    out.push(
      "NOTE: the recorder was armed in this document by this call, so anything the page did before now " +
        "(including its load-time requests) is not in the buffer. Navigate or reload to capture a fresh " +
        "document from its first request.",
    );
  }
  if (!notes.registered && notes.registerError) out.push(`NOTE: ${notes.registerError}`);
  return out;
}

/** 渲染。**永不抛**：入参是 `unknown`，逐字段判型。 */
export function renderNetwork(value: unknown, notes: NetworkNotes): string {
  const v = asRecord(value) ?? {};
  const items = asArray(v["items"]).map(asRecord).filter((x): x is Record<string, unknown> => x !== null);
  const head = header(v, notes.filter);
  if (!items.length) {
    return [head, emptyText(v, notes), ...notesText(v, notes)].filter(Boolean).join("\n");
  }
  const from = windowStart(v);
  const lines = items.map((item, i) => renderRow(item, from + i));
  return [head, failureLine(v, notes.filter), ...lines, ...notesText(v, notes)].filter((l): l is string => !!l).join("\n");
}

/** 两种空必须可辨：这次才装（附注里说了）/ 装了但没请求 / 有请求但全被 filter 滤掉。 */
function emptyText(value: Record<string, unknown>, notes: NetworkNotes): string {
  if (value["armedBefore"] !== true) return "No requests recorded yet.";
  if ((Number(value["total"]) || 0) > 0) {
    return `No requests matched ${JSON.stringify(notes.filter ?? "")} — ${Number(value["total"])} were recorded in total.`;
  }
  return (
    "No requests recorded: this document has made no fetch/XHR call since the recorder was armed. " +
    "(If you expected a page-load request, reload — the recorder covers every document from the moment it is registered.)"
  );
}
