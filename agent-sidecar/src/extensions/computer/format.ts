// 电脑操作回包 → 模型读的文本。只做呈现，不做判断（判断都在 Rust 执行器里）。

type Rec = Record<string, unknown>;

export interface WindowInfo {
  id: string;
  title: string;
  process: string;
  foreground?: boolean;
  minimized?: boolean;
  accessible?: boolean;
}

export interface ViewElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states?: string[];
  depth: number;
  text?: string;
}

function rec(v: unknown): Rec {
  return v && typeof v === "object" ? (v as Rec) : {};
}

function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function windowLine(w: WindowInfo): string {
  const flags: string[] = [];
  if (w.foreground) flags.push("foreground");
  if (w.minimized) flags.push("minimized");
  if (w.accessible === false) flags.push("runs as administrator — cannot operate");
  return `${w.id}  "${w.title}"  ${w.process || "?"}${flags.length ? `  [${flags.join(", ")}]` : ""}`;
}

export function formatWindows(data: unknown): string {
  const ws = arr<WindowInfo>(rec(data).windows);
  if (ws.length === 0) return "No windows are open.";
  const sorted = [...ws].sort((a, b) => Number(!!b.foreground) - Number(!!a.foreground));
  return `Open windows (${ws.length}):\n${sorted.map((w) => `- ${windowLine(w)}`).join("\n")}`;
}

function quoteBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((l) => `${indent}| ${l}`)
    .join("\n");
}

export function elementLine(e: ViewElement, indent = ""): string {
  let line = `${indent}[${e.ref}] ${e.role}`;
  if (e.name) line += ` "${e.name}"`;
  if (e.value !== undefined) line += ` = "${e.value}"`;
  if (e.states?.length) line += ` (${e.states.join(", ")})`;
  if (e.text) line += ` text:\n${quoteBlock(e.text, `${indent}    `)}`;
  return line;
}

export function formatRead(data: unknown): string {
  const d = rec(data);
  const w = rec(d.window) as unknown as WindowInfo;
  const head = [`Window ${windowLine(w)}`, `obs ${String(d.obs)}`];
  if (typeof d.focused === "string") head.push(`focused ${d.focused}`);
  const lines = [head.join(" · ")];
  if (typeof d.note === "string") lines.push(`NOTE: ${d.note}`);
  for (const e of arr<ViewElement>(d.elements)) lines.push(elementLine(e, "  ".repeat(e.depth)));
  if (typeof d.truncated === "string") lines.push(`(${d.truncated})`);
  const shot = rec(d.screenshot);
  if (typeof shot.width === "number") {
    lines.push(
      `Screenshot attached: ${shot.width}×${String(shot.height)} px, obs ${String(d.obs)}. ` +
        `To click a spot that has no ref, use target {x, y, obs: ${String(d.obs)}} in this image's pixels.`,
    );
  }
  if (typeof d.screenshot_error === "string") lines.push(`Screenshot failed: ${d.screenshot_error}`);
  return lines.join("\n");
}

export function screenshotOf(data: unknown): string | undefined {
  const b64 = rec(rec(data).screenshot).png_base64;
  return typeof b64 === "string" && b64 ? b64 : undefined;
}

function formatChanges(changes: unknown): string[] {
  if (typeof changes === "string") return [`Changes in this window: ${changes}.`];
  const c = rec(changes);
  const out: string[] = [];
  for (const e of arr<ViewElement>(c.added)) out.push(` + ${elementLine({ ...e, depth: 0 })}`);
  for (const e of arr<Rec>(c.removed)) out.push(` - [${String(e.ref)}] ${String(e.role)} "${String(e.name)}"`);
  for (const ch of arr<Rec>(c.changed)) {
    const parts = arr<[string, string, string]>(ch.fields).map(([f, a, b]) => `${f} "${a}" → "${b}"`);
    let line = ` ~ [${String(ch.ref)}] ${String(ch.role)} "${String(ch.name)}"`;
    if (parts.length) line += `: ${parts.join("; ")}`;
    if (typeof ch.text_added === "string" && ch.text_added) {
      line += ` new text:\n${quoteBlock(ch.text_added, "     ")}`;
    }
    out.push(line);
  }
  if (typeof c.omitted === "number" && c.omitted > 0) out.push(` (… ${c.omitted} more changes not listed)`);
  if (out.length === 0) return ["Changes in this window: none visible."];
  return ["Changes in this window:", ...out];
}

function formatAfter(after: unknown): string[] {
  const a = rec(after);
  const lines: string[] = [];
  const fg = a.foreground ? windowLine(rec(a.foreground) as unknown as WindowInfo) : "none";
  const head = [`Foreground: ${fg}`];
  if (a.obs !== undefined) head.push(`obs ${String(a.obs)}`);
  if (typeof a.focused === "string") head.push(`focused ${a.focused}`);
  lines.push(head.join(" · "));
  for (const w of arr<WindowInfo>(a.opened_windows)) lines.push(`Opened window: ${windowLine(w)}`);
  for (const w of arr<Rec>(a.closed_windows)) lines.push(`Closed window: ${String(w.id)} "${String(w.title)}"`);
  if (a.window_gone) lines.push("The target window is gone.");
  if (typeof a.read_error === "string") lines.push(`Could not read the window afterwards: ${a.read_error}`);
  if (a.changes !== undefined) lines.push(...formatChanges(a.changes));
  return lines;
}

export function formatAct(data: unknown): string {
  const d = rec(data);
  const lines = [`Executed ${String(d.executed)} of ${String(d.of)} steps.`];
  for (const s of arr<Rec>(d.steps)) lines.push(`${String(s.step)}. ${String(s.done)}`);
  if (typeof d.stopped === "string") lines.push(`STOPPED: ${d.stopped}`);
  lines.push(...formatAfter(d.after));
  return lines.join("\n");
}

export function formatWait(data: unknown): string {
  const d = rec(data);
  const lines = [d.met ? `Condition met after ${String(d.waited_ms)} ms.` : `Timed out after ${String(d.waited_ms)} ms.`];
  if (typeof d.note === "string") lines.push(d.note);
  if (d.window) lines.push(`Window: ${windowLine(rec(d.window) as unknown as WindowInfo)}`);
  if (typeof d.window_gone === "string") lines.push(`Window ${d.window_gone} is gone.`);
  if (d.element) lines.push(`Element: ${elementLine({ ...(rec(d.element) as unknown as ViewElement), depth: 0 })}`);
  if (typeof d.foreground === "string") lines.push(`Foreground is now ${d.foreground}.`);
  if (d.obs !== undefined) lines.push(`obs ${String(d.obs)}`);
  if (d.changes !== undefined) lines.push(...formatChanges(d.changes));
  return lines.join("\n");
}

export function formatWindowAction(data: unknown): string {
  const d = rec(data);
  const lines: string[] = [];
  if (typeof d.launched === "string") lines.push(`Launched ${d.launched}.`);
  if (d.window) lines.push(`Window: ${windowLine(rec(d.window) as unknown as WindowInfo)}`);
  if (d.closed) lines.push("The window closed.");
  else if (d.window === null) lines.push("The window may still be open (it might be asking to save) — check computer_windows.");
  if (typeof d.note === "string") lines.push(d.note);
  return lines.join("\n") || "Done.";
}
