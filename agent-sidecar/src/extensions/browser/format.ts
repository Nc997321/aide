import type { FrameEvalOutcome, FrameRead } from "./frames.js";
import type { EvalProbe } from "./runEval.js";

/**
 * 浏览器工具的结果 → 模型可读文本。
 *
 * 两条纪律（与 `knowledge/format.ts` 同源）：
 * 1. **永不抛**：桥回来的 `data` 是 `unknown`，畸形形状下格式化器解引用就会抛，而 MCP 会把
 *    抛出的 handler 变成 `isError`。这里一律按「可能缺字段」写，宁可少说不可炸。
 * 2. **如实**：降级/截断/跨域都要说出来，不把「没读到」伪装成「页面是空的」。
 */

/** 缺省视图时的引导语（`view_id` 解析失败时 Rust 给的错误已足够具体，这里只补一条下一步）。 */
export const NO_VIEW_TEXT =
  "No embedded browser view is open. Open one in Aide's browser panel (Ctrl+Shift+B), navigate it " +
  "to the page you want, then call this tool again.";

/** 桥/引擎失败 → 文本。`error` 由 Rust 侧保证是面向模型的说明，不加工直接透出。 */
export function formatBridgeFailure(resp: {
  error?: string;
  timedOut?: boolean;
  cancelled?: boolean;
}): string {
  if (resp.cancelled) return `Browser call cancelled: ${resp.error ?? "the session was interrupted"}`;
  if (resp.timedOut) {
    return (
      "Browser call timed out — the desktop host did not reply. " +
      "This usually means the browser view was closed while the call was in flight."
    );
  }
  return `Browser call failed: ${resp.error ?? "unknown error"}`;
}

// ---- 形状守门（data 是 unknown，逐字段判型；缺字段不抛、不猜） ----
//
// 三个助手**导出**：`network.ts` / `console.ts` / `recorder.ts` 吃的都是页面侧信封（同样是
// `unknown`），逐字段判型的写法只该有一份——复制过去的那种，改了一处忘另一处就会漂。

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 定宽左对齐——行首那一列的宽度靠它统一（network 的方法、console 的级别标签），
 * 这样 URL / 正文才对齐成一列，扫列比扫行快。
 * `padEnd` 不截断超长串：宁可错一格，也不许悄悄吃掉内容。
 */
export function pad(s: string, n: number): string {
  return s.padEnd(n);
}

/**
 * CDP 回包里的**方法级错误**——`{error:{code,message}}`。返回 null = 这次调用真的成了。
 *
 * ⚠️ 方法级拒绝是一个**合法 JSON 响应体**，桥只做 JSON 解析 → 它带着 `ok:true` 一路回来。
 * 不看它的调用点都会**报假成功**（`act.ts` 的文件头有完整来龙去脉：一次运行时拒绝的点击
 * 会被报成"已用真实鼠标事件点击"——而它根本没点）。原先 `act.ts` / `screenshot.ts` 各写了
 * 一份，这里收口成唯一一份。
 */
export function cdpMethodError(data: unknown): string | null {
  const e = asRecord(asRecord(asRecord(data)?.["value"])?.["error"]);
  return e ? String(e["message"] ?? e["code"] ?? "unknown") : null;
}

/**
 * 一次成功求值的**结果视图**——`runEval` 的成功返回去掉通道细节。
 *
 * 做成对象而不是三个位置参数：`viewId` 与 `probe` 都是可缺省的旁注，摊平了容易传错位。
 */
export interface EvalView {
  value: unknown;
  /** Rust 解析出的视图 id（调用方省略 `view_id` 时才有价值）。 */
  viewId?: string;
  probe: EvalProbe;
}

/**
 * 隐藏视图对**读取类**结果意味着什么。
 *
 * 与动作类不同：读到的内容**多半是真的**（DOM 在，`textContent` 在），但依赖渲染的东西会缺
 * ——懒加载没触发、过渡没跑完、`innerText` 类取值可能为空。所以措辞落在"结果是可信的这一句
 * 不成立"，而不是"结果不可信"。
 *
 * （曾经这里还有一句"视图隐藏 → 渲染类内容可能没发生"的告警。parking 落地后不显示的视图照样
 *   合成，那句只剩噪音，删了。）
 */

/** 异步没等到（只可能出现在 CDP 不可用的降级路径上）。 */
const PENDING_NOTE =
  "NOTE: your script returned a Promise and this runtime's fallback channel cannot await it — what you " +
  "got back is the unresolved Promise, not its value. This happens when the CDP path is unavailable on " +
  "this machine. Restructure the script to return a plain value, or have it park the result on `window` " +
  "and read it in a second call.";

/**
 * 求值结果的旁注：异步没等到（只在**真的发生时**出现）。
 *
 * 入参刻意是 `unknown`：本模块的铁律是"data 是 unknown，畸形形状下解引用就会炸成 isError"，
 * 所以这里自己收窄，不假设调用方给对了形状。
 */
function evalNotes(raw: unknown): string[] {
  const probe = asRecord(raw);
  return probe?.["pending"] === true ? [PENDING_NOTE] : [];
}

/** CDP 帧级读取的结果（跨域 iframe）。见 `frames.ts`。 */
export interface FrameReadOutcome {
  frames: FrameRead[];
  /** 帧级读取整体不可用时的原因（如 CDP 域名不支持）——**如实带出**，不吞。 */
  error?: string;
}

/**
 * 投影脚本回了个非对象。
 *
 * 注意：**抛异常不再走这里**——`runEval` 拿 CDP 的 `exceptionDetails` 把"抛了"与"返回了 null"
 * 分开了，异常有它自己的文案。所以这里只剩一种解释：脚本自己返回了个非对象（`null`/字符串…）。
 */
function malformedValueNote(raw: unknown): string {
  return (
    "The page script returned no usable value (`null` or a non-object). " +
    `Raw result: ${JSON.stringify(raw)?.slice(0, 200) ?? "null"}`
  );
}

// ---- browser_tabs ----

export function formatTabs(data: unknown): string {
  const views = asArray(asRecord(data)?.["views"]);
  if (views.length === 0) return NO_VIEW_TEXT;

  const lines = views.map((v) => {
    const view = asRecord(v);
    if (!view) return "- (unreadable view entry)";
    const nav = asRecord(view["nav"]) ?? {};
    const state = str(nav["state"]) || "unknown";
    const url = str(nav["url"]);
    const title = str(nav["title"]);
    // `displayed` = 露在用户面板上；`parked` = 后台活着但没人看得见（合成照跑，见 spec）。
    const flags = [
      state,
      view["displayed"] === true ? "displayed" : "parked",
      view["can_go_back"] === true ? "can-go-back" : "",
    ].filter(Boolean);
    const head = `${str(view["id"])} [${flags.join(", ")}]`;
    const where = url ? ` ${url}` : "";
    // label 优先于页面标题：多 agent 挂同一个 dev server 时，只有 label 分得开谁是谁。
    const label = str(view["label"]);
    const named = label ? ` "${label}"` : title ? ` — ${title}` : "";
    return `- ${head}${named}${where}`;
  });

  return [
    `${views.length} embedded browser view(s). Pass one of these ids as \`view_id\` to target it:`,
    ...lines,
  ].join("\n");
}

// ---- browser_read（通用骨架投影） ----

// ---- 骨架分节渲染（主文档与帧内容共用；`level` = markdown 标题层级） ----

function renderTables(raw: unknown, level = 2): string[] {
  const tables = asArray(raw);
  if (!tables.length) return [];
  const out = ["", `${"#".repeat(level)} Tables (${tables.length})`];
  tables.forEach((t, i) => {
    const table = asRecord(t);
    if (!table) return;
    const caption = str(table["caption"]);
    out.push(`${"#".repeat(level + 1)} Table ${i + 1}${caption ? ` — ${caption}` : ""}`);
    const headers = asArray(table["headers"]);
    if (headers.length) out.push(`| ${headers.map((c) => str(c)).join(" | ")} |`);
    for (const row of asArray(table["rows"])) {
      out.push(`| ${asArray(row).map((c) => str(c)).join(" | ")} |`);
    }
  });
  return out;
}

function renderFields(raw: unknown, level = 2): string[] {
  const fields = asArray(raw);
  if (!fields.length) return [];
  const out = ["", `${"#".repeat(level)} Form fields (${fields.length})`];
  for (const f of fields) {
    const field = asRecord(f);
    if (!field) continue;
    const bits = [
      `[${str(field["tag"])}${field["type"] ? `:${str(field["type"])}` : ""}]`,
      field["label"] ? `label="${str(field["label"])}"` : "(no label found)",
      field["name"] ? `name="${str(field["name"])}"` : "",
      `value="${str(field["value"])}"`,
      field["disabled"] === true ? "DISABLED" : "",
      field["required"] === true ? "required" : "",
    ].filter(Boolean);
    const options = asArray(field["options"]);
    const opts = options.length
      ? ` options=${options
          .map((o) => {
            const r = asRecord(o);
            return r ? `${str(r["text"])}${r["selected"] === true ? "*" : ""}` : "";
          })
          .filter(Boolean)
          .join(" | ")}`
      : "";
    out.push(`- ${bits.join(" ")}${opts}`);
  }
  return out;
}

function renderClickables(raw: unknown, level = 2): string[] {
  const clickables = asArray(raw);
  if (!clickables.length) return [];
  const out = ["", `${"#".repeat(level)} Clickable elements (${clickables.length})`];
  for (const c of clickables) {
    const r = asRecord(c);
    if (!r) continue;
    const href = str(r["href"]);
    out.push(
      `- ${str(r["tag"])} "${str(r["text"])}"${href ? ` → ${href}` : ""}${r["disabled"] === true ? " (DISABLED)" : ""}`,
    );
  }
  return out;
}

/**
 * 隐藏项计数 → 一行 NOTE。
 *
 * 默认不列隐藏的东西（`display:none` 的 popper / teleport 面板是纯噪音），但**绝不静默**：
 * 报数 + 给出 `include_hidden` 这个开关。少了这行，"页面结构全空"与"结构都被隐藏筛掉了"
 * 在模型眼里长得一样——正是本项目反复踩的"没读到 ≠ 没有"。
 */
function hiddenSkippedNote(value: Record<string, unknown>): string | null {
  const skipped = asRecord(value["hiddenSkipped"]);
  if (!skipped) return null;
  const parts = (["headings", "tables", "fields", "clickables"] as const)
    .map((key) => {
      const n = Number(skipped[key]) || 0;
      return n > 0 ? `${n} ${key}` : null;
    })
    .filter((x): x is string => x !== null);
  if (!parts.length) return null;
  return (
    `NOTE: ${parts.join(", ")} hidden (display:none / zero-size) and not listed — ` +
    `pass include_hidden to include them.`
  );
}

/**
 * `include_hidden` 与 Raw text 的关系说明。
 *
 * **只在"没过滤成"时出现**：默认路径走 `innerText`（浏览器自己的可见性感知 API），隐藏内容本来就
 * 不在里面，说一句只是噪音；只有拿不到 `innerText` 而退回 `textContent` 的那份结果才需要承认
 * "这一份没过滤"（不静默降级，同 `hiddenSkippedNote` 的纪律）。
 *
 * `include_hidden` 时不出现：那一份文本**与开关一致**（骨架也列了隐藏项），不是降级。
 *
 * 调用点跟着正文走（没正文就不出）——旁注是在为**下面那段文本**作注解，悬空的旁注等于凭空
 * 暗示"这里有隐藏内容"。
 */
function textFilterNote(value: Record<string, unknown>): string | null {
  if (value["textFiltered"] !== false) return null;
  return (
    "NOTE: the raw text below is the document's full text content, not only text that is actually " +
    "rendered — hidden (display:none) content may be included. This runtime could not produce " +
    "rendered text."
  );
}

/**
 * 正文小节：**旁注在前 → 空行 → 标题 → 正文**。主文档与帧内容共用这一份（这段"先注解再正文"
 * 的排布在两边各写一遍，改一处忘一处就会漂）。
 *
 * 旁注跟着正文走（没正文就不出）——它是在为**下面那段文本**作注解，悬空的旁注等于凭空暗示
 * "这里有隐藏内容"（见 `textFilterNote`）。
 */
function renderTextBlock(value: Record<string, unknown>, heading: string): string[] {
  const text = str(value["text"]);
  if (!text) return [];
  const note = textFilterNote(value);
  return [...(note ? [note] : []), "", heading, text];
}

/** 结构面（表格 / 表单字段 / 可点元素）是否全空。 */
function hasNoStructure(value: Record<string, unknown>): boolean {
  return (
    asArray(value["tables"]).length === 0 &&
    asArray(value["fields"]).length === 0 &&
    asArray(value["clickables"]).length === 0
  );
}

/**
 * 「投影成功了，但没抽出任何结构」的**显式说明**。
 *
 * 不加这句，「读成功 + 页面确实没有语义结构」会渲染成一个光秃秃的小节——**与「帧是空的」
 * 在视觉上无法区分**。2026-09-16 agent 实测被这个假信号误导过：它看到 `Frame content 1`
 * 只有一行 title，差点据此下结论说那页是空的（实际那个帧有 592 字符文本、448 个 div）。
 *
 * 三种状态必须**各自可辨**：读失败（带原因）/ 读到了但无结构（这里）/ 读到了且有结构。
 */
function emptyShapeNote(value: Record<string, unknown>): string[] {
  if (!hasNoStructure(value)) return [];
  const text = str(value["text"]);
  if (text) {
    return [
      "",
      "NOTE: this was read successfully, but it carries no semantic structure (no tables, form fields or " +
        "buttons). The text below is the whole of it — pages built from positioned divs (design-tool exports, " +
        "canvas-like layouts) read this way. Use browser_eval with `frame` if you need a shape out of it.",
    ];
  }
  return [
    "",
    "NOTE: read successfully, and this document contains no extractable structure OR text. " +
      "That is a property of the page, not a read failure.",
  ];
}

/**
 * iframe 清单。三种状态**必须可区分**（混为一谈会让模型宣布"这页没内容"）：
 * 同源已读 / 跨域但经 CDP 读到了 / 跨域且读不到（带原因）。
 */
function renderFrames(raw: unknown, frameOutcome?: FrameReadOutcome): string[] {
  const frames = asArray(raw);
  if (!frames.length) return [];
  const readByUrl = new Map((frameOutcome?.frames ?? []).map((f) => [f.url, f] as const));

  const out = ["", `## Frames (${frames.length})`];
  frames.forEach((f, i) => {
    const r = asRecord(f);
    if (!r) return;
    const src = str(r["src"]);
    if (r["sameOrigin"] === true && r["content"]) {
      const inner = asRecord(r["content"]);
      out.push(`- frame ${i + 1} ${src} — same-origin, content below`);
      if (inner) {
        out.push(`  inner title: ${str(inner["title"]) || "(none)"}`);
        out.push(
          `  inner tables: ${asArray(inner["tables"]).length}, fields: ${asArray(inner["fields"]).length}, clickables: ${asArray(inner["clickables"]).length}`,
        );
      }
      return;
    }
    const read = readByUrl.get(src);
    if (read?.value) {
      out.push(`- frame ${i + 1} ${src} — cross-origin, read via CDP frame-level evaluation (content below)`);
    } else if (read?.error) {
      out.push(`- frame ${i + 1} ${src} — cross-origin and could NOT be read: ${read.error}`);
    } else {
      out.push(
        `- frame ${i + 1} ${src} — CROSS-ORIGIN, contents are NOT readable from here. ` +
          `Open it at its own URL to read it.`,
      );
    }
  });
  return out;
}

export function formatRead(view: EvalView, frameOutcome?: FrameReadOutcome): string {
  // 签名是 `EvalView`，但这里**不假设**它真是（`formatRead(bad)` 有专门的守卫测试）。
  const v = asRecord(view) ?? {};
  const viewId = str(v["viewId"]) || "?";
  const value = asRecord(v["value"]);

  if (!value) return malformedValueNote(v["value"]);
  if (value["ok"] === false) {
    return `Page projection failed: ${str(value["error"]) || "unknown error"}`;
  }

  const out: string[] = [];
  const title = str(value["title"]);
  const url = str(value["url"]);
  out.push(`view ${viewId}${url ? ` · ${url}` : ""}`);
  if (title) out.push(`title: ${title}`);
  const ready = str(value["readyState"]);
  if (ready && ready !== "complete") {
    out.push(`readyState: ${ready} — the page may still be loading; read again if content looks thin.`);
  }
  if (value["truncated"] === true) {
    out.push("NOTE: content was truncated against the size caps — this is a partial view of the page.");
  }
  const hiddenNote = hiddenSkippedNote(value);
  if (hiddenNote) out.push(hiddenNote);

  const headings = asArray(value["headings"]);
  if (headings.length) {
    out.push("", "## Outline");
    for (const h of headings) {
      const r = asRecord(h);
      if (!r) continue;
      out.push(`${"#".repeat(Math.min(6, Number(r["level"]) || 1))} ${str(r["text"])}`);
    }
  }

  out.push(...renderTables(value["tables"]));
  out.push(...renderFields(value["fields"]));
  out.push(...renderClickables(value["clickables"]));
  out.push(...renderFrames(value["frames"], frameOutcome));

  if (frameOutcome?.error) out.push("", `NOTE: ${frameOutcome.error}`);

  // 跨域帧的内容——往往是这一页**真正**要看的东西（设计交付工具把原型本体放在跨域 iframe 里，
  // 父页面自己什么都读不到）。渲染成同级小节，让模型不必自己再去拼。
  (frameOutcome?.frames ?? []).forEach((fr, i) => {
    if (!fr.value) return;
    out.push("", `## Frame content ${i + 1} — ${fr.url}`);
    if (fr.value["ok"] === false) {
      out.push(`projection failed: ${str(fr.value["error"]) || "unknown error"}`);
      return;
    }
    const frameTitle = str(fr.value["title"]);
    if (frameTitle) out.push(`title: ${frameTitle}`);
    out.push(...renderTables(fr.value["tables"], 3));
    out.push(...renderFields(fr.value["fields"], 3));
    out.push(...renderClickables(fr.value["clickables"], 3));
    // 说明放文本**之前**——它是在为下面那段作注解。
    out.push(...emptyShapeNote(fr.value));
    // 帧自己的隐藏计数（同一份脚本跑出来的，别只报主文档的）。
    const frameHidden = hiddenSkippedNote(fr.value);
    if (frameHidden) out.push(frameHidden);
    // 帧文本**必须渲染**。漏了它，结构面全空、内容全在文本里的页面（设计工具导出的绝对定位
    // div 画布正是如此）就只剩一行 title，与空帧无法区分。主文档一直有 `## Raw text`，
    // 帧这边当初漏了——2026-09-16 agent 实测踩到。
    // （同一份脚本跑的，过滤成没成也在帧的信封里——主文档有的旁注，帧这半边同样要有；
    //   跨域原型的内容全在帧里，漏了它就是静默降级。`renderTextBlock` 两件事一起做。）
    out.push(...renderTextBlock(fr.value, "#### Text"));
  });

  out.push(...renderTextBlock(value, "## Raw text"));

  // 旁注放最后：它是**关于上面这一整份结果**的免责说明，不是页面内容的一部分。
  const notes = evalNotes(v["probe"]);
  if (notes.length) out.push("", ...notes);

  return out.join("\n");
}

/** 求值结果的渲染上限（字符）。 */
const EVAL_TEXT_CAP = 20000;

/**
 * 求值结果 → 文本。
 *
 * **字符串原样印**：脚本自己 `JSON.stringify` 过的结果再 stringify 一层，就是满屏 `\"` 与
 * `\n` 的转义串（2026-10-07 agent 实测反馈）——模型读得费劲、token 也翻倍。能解析成对象/数组的
 * 字符串按 JSON 美化一次；其余字符串（含 `"123"`）原样给出。表头的 `(string)` 交代它本来就是串，
 * 不让模型把 `"123"` 误当成数字 123。
 */
function renderEvalValue(value: unknown): { kind: string; text: string } {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = undefined;
    }
    const pretty = typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed, null, 2) : value;
    return { kind: " (string)", text: pretty.slice(0, EVAL_TEXT_CAP) };
  }
  const rendered = JSON.stringify(value, null, 2);
  return { kind: "", text: rendered === undefined ? "undefined" : rendered.slice(0, EVAL_TEXT_CAP) };
}

/**
 * `browser_eval` 在**跨域帧**里的结果。
 *
 * 找不到帧时列出可用帧——这是 agent 手里唯一的指认手段（它只有 `browser_read` 给的 URL），
 * 不给清单它就只能瞎试。
 */
export function formatFrameEval(outcome: FrameEvalOutcome): string {
  if (!outcome.ok) {
    const lines = [`Could not evaluate in a frame: ${outcome.error}`];
    if (outcome.available.length) {
      lines.push("", "Frames available on this page (pass a substring of one as `frame`):");
      for (const u of outcome.available) lines.push(`- ${u}`);
    }
    return lines.join("\n");
  }
  const r = renderEvalValue(outcome.value);
  const lines = [`frame ${outcome.url} — script result${r.kind}:`, r.text];
  if (outcome.probe) lines.push("", ...evalNotes(outcome.probe));
  return lines.join("\n");
}

// ---- browser_eval ----

export function formatEval(view: EvalView): string {
  const v = asRecord(view) ?? {};
  const r = renderEvalValue(v["value"]);
  const lines = [`view ${str(v["viewId"]) || "?"} — script result${r.kind}:`, r.text];
  const notes = evalNotes(v["probe"]);
  if (notes.length) lines.push("", ...notes);
  return lines.join("\n");
}
