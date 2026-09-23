import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toForwardSlashes, safeDirname } from "../engine/winPaths.js";

/**
 * browser-inspect skill 自动落地（内建，免用户配置）。
 *
 * 动机与 `codegraphSkill` 同源：MCP 工具光注册 + instructions 只解决「工具存在时怎么选」，
 * **任务级工作流**要靠 skill 触发（那套机制 2026-07-26 两轮 A/B 实锤有效）。这里管的流程是
 * 「用户丢一个原型/设计稿/规格页链接过来 → 读出整套页面规格」。
 *
 * # 站点适配住哪（本文件最重要的约定）
 *
 * `references/` 目录是**站点适配层**：某个站点需要特殊读法时，**写一份 reference 文件**
 * （数据），而不是去改工具、改 Rust、改 MCP server。
 *
 * 验收尺：**换一个站点，`src-tauri/` 与 MCP server 一行不动**。
 * 因此源码里 grep 任何站点名都必须恒为 0（`.test.ts` 的守卫词表除外）——
 * 站点名只准出现在落盘后的 reference 文件里。
 *
 * ⚠️ **不预置任何站点 reference**：没见过真实 DOM 就写适配脚本 = 编造选择器，
 * 比没有更糟（看起来权威但点不中）。适配脚本在真正看过那个页面之后才写。
 */

type Env = Record<string, string | undefined>;

const SKILL_DIR_NAME = "browser-inspect";

/** skill 目录：`$CLAUDE_CONFIG_DIR/skills/browser-inspect`（正斜杠形式，规避 bun path 缺陷）。 */
export function browserSkillDir(env: Env): string {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".aide", "claude");
  return toForwardSlashes(path.join(toForwardSlashes(dir), "skills", SKILL_DIR_NAME));
}

export function browserSkillPath(env: Env): string {
  return path.join(browserSkillDir(env), "SKILL.md");
}

/** 站点适配 reference 的落地路径（供将来写站点适配时使用）。 */
export function browserReferencePath(env: Env, name: string): string {
  return path.join(browserSkillDir(env), "references", `${name}.md`);
}

export const SKILL_CONTENT = `---
name: browser-inspect
description: Use when the user points you at a design prototype, wireframe, or spec page (often a link to a design-handoff tool) and asks what it contains or what needs building from it — or asks you to read, summarize, or operate the page they are currently viewing in Aide's embedded browser. Covers reading a page's structure, walking multiple pages of a prototype, and turning that into a specification.
---

# Reading a live page as a specification

The \`aide-browser\` MCP tools drive the embedded browser pane in Aide. The page there is real and already signed in as the user — read it directly instead of fetching it with curl (that would miss the session and the page's live state).

## Mandatory workflow

1. **Find the view — or open your own.** Call \`browser_tabs\`: it lists the open views with ids, labels, urls and whether each is \`displayed\` (on screen for the user) or \`parked\` (alive in the background — it still renders, so lazy content, transitions and screenshots all work). A view survives the panel being closed or another tab being selected, so the page may already be open. If you need a tab of your own — you are not the only one driving pages, or the user is looking at something else — call \`browser_tab\` with \`action:"open"\`: it creates a parked view and returns a \`view_id\` that is yours. **Keep that id and pass it explicitly from then on**: with more than one view open the other tools refuse to guess, they fail rather than act on the wrong tab. Close it with \`action:"close"\` when you are done (parked views keep rendering). \`action:"focus"\` brings a view into the user's panel and steals what they are looking at — only when they should actually see the page.
2. **Read the skeleton first.** Call \`browser_read\` before anything else. It returns outline, tables, form fields (with labels and options), clickable elements, frames and raw text for the top document plus same-origin frames. One call replaces a long series of script probes. "Clickable" includes controls a page built out of \`div\`/\`span\` — recognized by \`cursor:pointer\`, a role, or a handler attribute. Hidden (\`display:none\`) tables, fields and controls are left out and counted in a note; pass \`include_hidden\` when the page stacks whole screens that way. The raw text section lists **rendered text only**, and \`include_hidden\` governs it too.
3. **Only then reach for scripts.** If the skeleton does not carry what you need, use \`browser_eval\` to extract exactly that shape. See \`references/page-extraction.md\` for how to write an extraction that stays cheap.
4. **To reach other pages**, use \`browser_act\` (click / fill / hover) — target an element by its visible \`text\`. Clicking through a prototype's own navigation is usually the only way to reach pages that no URL exposes. \`browser_act\` results say whether the click went through real CDP input or a synthetic fallback.
5. **After an action, wait with \`browser_wait\` — never hand-roll a polling loop.** \`until:"condition"\` polls a synchronous expression you supply; \`until:"load"\` waits for a navigation to finish, which no in-page expression can do. A timeout is reported, not raised: it tells you how many times it polled and what it last saw. Read that before concluding the page is broken.
6. **When the question is visual, look at it.** \`browser_screenshot\` answers "which panel is the user actually looking at" — and "did this render at all" — far faster than reasoning about coordinates. It is the fallback, not the default: an image costs far more context than text and gives you pixels rather than structure. Reach for it when the structured read genuinely cannot answer, not before. Pass \`text\` or \`selector\` to crop it to a single element — when one control is the whole question, that is usually the cheapest shot there is.
7. **Deliver a specification, not a transcript.** The user wants a structured result — page inventory, tables with their columns, form fields with their labels, actions available, and how pages link. Do not paste raw page dumps into the answer.

## Three things that will bite you

- **Cross-origin frames need a different door — not a different page.** The parent document's own scripts cannot touch them, but \`browser_read\` reaches in anyway through CDP frame-level evaluation, and \`browser_eval\` with \`frame\` runs *your* script inside them. Do not navigate away, and do not fetch the frame's URL yourself — the interesting content is usually inside a frame, and both detours lose the page you were reading. If a read does report one as unreadable, that means the runtime refused; opening the frame's URL is then the fallback.
- **A view you cannot see keeps working.** Not being displayed (panel closed, another tab selected, or a view you opened yourself) means only that nobody is looking at it: the page still renders, timers run, transitions finish, screenshots and real input work. So you may drive several views at once, and what you read back is current rather than stale — do not ask the user to bring a view to the front just to make things "work".
- **Prototypes show the happy path only.** Field types, validation rules, enumerations, permissions and error states are usually absent. Extract what is drawn, and mark what you had to infer — do not present an inference as something the design states.

## Site adapters live in \`references/\`

When a site needs a reading that the generic skeleton cannot express (a prototype nested in the host page's own chrome, widgets rendered as canvas, an unusual page tree), **write a reference file here** — e.g. \`references/<site>-<what>.md\` — holding the selectors and a ready-to-run extraction script, then read it back the next time.

Keep site knowledge in that file. Never inline it into the tools, the Rust side, or the MCP server: the whole point is that adding a site means adding data, not code.
`;

export const PAGE_EXTRACTION_REFERENCE = `# Writing an extraction script for a page

Read this when \`browser_read\`'s skeleton does not carry what you need and you are about to call \`browser_eval\`.

## The cost model decides the shape

Do **not** read a page by looking at it repeatedly. A single page's raw DOM runs to tens of thousands of tokens and is almost entirely layout noise; you want the parsed result, not the markup.

Write one script that returns exactly the fields you need, then run it. If you need the same shape from many pages, that script is the thing you carry between them — not a habit of re-reading.

## Contract

- **Return a small object**, never \`document.body.outerHTML\` and never the whole DOM. The value of the last expression is JSON-serialised into your context.
- **It may be async.** \`browser_eval\` awaits the value, so \`(async () => { const r = await fetch(...); return {ok:true, rows: r} })()\` returns the resolved object. You do not need to park results on \`window\` and read them in a second call.
- **An exception is reported as an exception.** Throwing is no longer indistinguishable from returning null — you get the error text. Returning your own \`{ok: true, ...}\` / \`{ok: false, error: "..."}\` envelope is still worth it, because it lets you say *which part* failed.
- **It is one EXPRESSION, not a program.** \`var x = 1; x + 2\` will not parse. Wrap statements: \`(() => { ... })()\`.
- **Cap everything**: rows, columns, text lengths. Add \`truncated: true\` when you hit a cap, so a partial answer never looks complete.
- **Resolve through the live DOM on every run.** Do not carry element handles or indices between calls — the page re-renders and they go stale silently. Re-find by selector or text each time.
- **Say what you could not read.** Cross-origin frames, canvas-rendered content and closed shadow roots are invisible to a script on the parent page. Report them as unreadable rather than omitting them.

## Generic patterns worth reusing

- **Tables**: \`table.querySelectorAll('tr')\`, mapping each row's \`children\` to trimmed \`textContent\`. Mark a leading all-\`<th>\` row as the header.
- **Form fields**: \`input,select,textarea\` (skip \`type=hidden\`), pairing each with its label via \`label[for]\`, an enclosing \`label\`, or the preceding cell in a table layout. Include the field's \`name\`, current \`value\`, \`required\`/\`disabled\` flags, and for a \`<select>\` the full option list with which is selected.
- **Never read \`type=password\` values.** Report that a password field exists and whether it is filled; the value is the user's credential and does not belong in your context.
- **Page tree / navigation**: link text plus \`href\`, and for menu-like structures the nesting. This is usually what tells you which pages exist.
- **Text**: strip \`script/style/noscript/template\` before reading \`textContent\`, and collapse whitespace. Treat the result as a fallback — a page rendered by a framework often yields a soup of fragments, which is exactly when the structured patterns above earn their keep.

## When the page has no semantic markup

Some pages carry their meaning entirely in **positioned \`<div>\`s** — prototypes exported from a design tool are the common case. There is no \`<table>\`, no \`<input>\`, no heading: the generic patterns above find nothing, and \`browser_read\` will honestly report a page with a title and little else. That is not a failure to work around by fetching the URL yourself; the content is right there in the frame.

Two steps:

1. **Check where it lives.** \`browser_read\` lists frames and marks the ones it read. A prototype is usually a **cross-origin** frame — the kind the top document's own scripts cannot touch.
2. **Run your own extraction inside that frame.** Call \`browser_eval\` with \`frame\` set to a substring of that frame's URL (as listed under \`Frames\`). Your script then evaluates with that frame's \`document\`, and can reach everything the generic skeleton could not.

What to look for once you are in there:

- **Geometry carries the structure.** Read \`getBoundingClientRect()\` and group elements by shared top/left edges — a row of cells shares a \`top\`; a column shares a \`left\`. That is how a div-built table is recovered.
- **Style carries the emphasis.** \`getComputedStyle\` gives you font weight, size and background — enough to tell a header from a cell, or a button from a label.
- **Text nodes are still text.** Collect leaf elements whose \`textContent\` is non-empty and whose children are all inline; that reconstructs the copy without dragging in container duplicates.
- **Read \`textContent\`, never \`innerText\`.** \`innerText\` reflects what is *rendered*, so it silently drops everything hidden with \`display:none\` — and prototypes hide whole page states that way. If your extraction comes back suspiciously short (a few hundred characters for a page that clearly has more), that is almost always why: the content is there, just hidden. \`textContent\` sees it.
- **Expect overlapping panels.** A prototype commonly stacks several screen mockups into one document and reveals one at a time. Do not assume the currently visible panel is the whole page — enumerate them all, and say which one was visible if that distinction matters to the answer. \`browser_read\` leaves \`display:none\` ones out by default (it counts them in a note): pass \`include_hidden\` to see the stacked screens. That switch covers the raw text too — by default that section is rendered text only.
- **Interaction hints: the cursor and the handlers.** \`cursor: pointer\`, a click-ish \`onclick\`, or a role attribute tell you what is clickable. The skeleton already applies exactly this rule for you; use the same signals in an extraction you write by hand inside a frame.

Write the result into your own \`{ok: true, ...}\` envelope, cap the size, and return it. Do not return the raw DOM — a prototype page's markup is mostly noise.

## Verifying your own app through the embedded browser

The same tools are how you check a change you just made in the app the user is running — an interceptor that rewrites a request, a CSS refactor that should change nothing. Two traps, both of which cost real time before they were written down:

- **A dynamic \`import()\` of your own source gets a cached module, not the current one.** Vite serves modules keyed by a \`?t=<timestamp>\` cache-buster; importing \`/src/foo.ts\` without it hands you the copy from before your edit, and you end up asserting against stale code and "discovering" that your fix does not work. Append the buster — import the module with a \`?t=\` query carrying the current time — or verify through the rendered app rather than by importing its modules.
- **Never poll from inside the page.** An in-page \`setTimeout\` loop spends a call, can outlive your patience, and reports nothing structured when it gives up. \`browser_wait\` polls from the host: it has a deadline, and a timeout comes back with how many times it polled and what it last saw.

When you are checking \`getComputedStyle\` values or geometry, the numbers are trustworthy as long as the view has a size — views you open with \`browser_tab\` get one from the host, and a view you cannot see keeps its last one (it still renders). A zero-size result means the element itself is collapsed, not that the view is hidden.

## Diagnosing a page that is not doing what you expect

Two buffers answer most of it, without a single round trip through the app's own logs:

- **\`browser_network\`** — the XHR/fetch calls with status, duration and a clipped response body. A page that came up blank is very often a request that returned 500 with the real reason in the body. Unfinished requests show as \`pending\`, which is how you catch a call that never returns.
- **\`browser_console\`** — the console messages, and separately the errors the page never caught. An error swallowed by the app's own \`try/catch\` shows up here and nowhere else.

Both read a buffer that lives in the **current document only**: navigating or reloading clears it, and the first call that has to install the recorder says so in its result. If you need the requests a page made *while loading*, arm the recorder (any \`browser_network\` / \`browser_console\` call does it) and then navigate or reload — the new document is recorded from its first request.
`;

/**
 * 确保 skill 文件存在且内容最新。写盘失败静默跳过（永不阻塞会话启动）。
 *
 * 路径用 winPaths 兜底（`toForwardSlashes` + `safeDirname`）：aide-agent.exe 内嵌 bun 的
 * `path.dirname` 对 Windows 反斜杠盘符路径返回 `"C:"`，`mkdirSync` 会落到错处；
 * 中文用户目录叠加该缺陷会导致 skill 不落地（同 codegraphSkill 的注释）。
 */
export function ensureBrowserSkill(env: Env): void {
  const files: { path: string; content: string }[] = [
    { path: browserSkillPath(env), content: SKILL_CONTENT },
    { path: browserReferencePath(env, "page-extraction"), content: PAGE_EXTRACTION_REFERENCE },
  ];
  for (const file of files) {
    try {
      // mkdirSync 独立 try：bun 的 recursive mkdir 对已存在目录抛 EEXIST（Node 是 no-op），
      // 不让它中断后续内容比对/写入（已装机器重跑也会更新漂移内容）。
      try {
        mkdirSync(safeDirname(file.path), { recursive: true });
      } catch {
        /* 父目录已存在(bun EEXIST) 或不可创建，继续尝试写 */
      }
      let current: string | null = null;
      try {
        current = readFileSync(file.path, "utf8");
      } catch {
        /* 不存在，下面写 */
      }
      if (current !== file.content) writeFileSync(file.path, file.content, "utf8");
    } catch {
      /* 配置目录不可写等情况：跳过，不影响会话 */
    }
  }
}
