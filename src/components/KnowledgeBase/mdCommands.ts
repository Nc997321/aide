// 编辑器的格式命令（加粗 / 斜体 / 行内代码 / 链接 / 标题 / 引用 / 列表 / 代码块）。
//
// 只做「在原文上加减标记」：不引入第二套文档模型，存下去的永远是用户看得见的 Markdown。
// 全部对 EditorView 操作、不碰 DOM，所以可以直接在 jsdom 里单测。
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * 行内标记的开关：选区已被标记包住（外围或内含）就拆掉，否则包上。
 * 空选区：插入一对标记并选中占位文字，用户直接打字替换。
 */
export function toggleWrap(view: EditorView, open: string, close = open, placeholder = "文本"): void {
  const state = view.state;
  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const text = state.sliceDoc(from, to);

    // 单字符标记（斜体 *）要躲开双字符（粗体 **）：`**x**` 里选 x 再点斜体，
    // 外围看到的 `*` 其实是粗体的一半，不能当成斜体拆掉。
    const outerBefore = from - open.length - 1 >= 0 ? state.sliceDoc(from - open.length - 1, from - open.length) : "";
    const outerAfter = state.sliceDoc(to + close.length, to + close.length + 1);
    const ambiguous = open.length === 1 && (outerBefore === open || outerAfter === close);

    const surrounded =
      !ambiguous &&
      from - open.length >= 0 &&
      state.sliceDoc(from - open.length, from) === open &&
      state.sliceDoc(to, to + close.length) === close;
    if (surrounded) {
      return {
        changes: [
          { from: from - open.length, to: from, insert: "" },
          { from: to, to: to + close.length, insert: "" },
        ],
        range: EditorSelection.range(from - open.length, to - open.length),
      };
    }

    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close) && !(open.length === 1 && text.startsWith(open + open))) {
      const inner = text.slice(open.length, text.length - close.length);
      return {
        changes: { from, to, insert: inner },
        range: EditorSelection.range(from, from + inner.length),
      };
    }

    if (from === to) {
      return {
        changes: { from, insert: open + placeholder + close },
        range: EditorSelection.range(from + open.length, from + open.length + placeholder.length),
      };
    }
    return {
      changes: [
        { from, insert: open },
        { from: to, insert: close },
      ],
      range: EditorSelection.range(from + open.length, to + open.length),
    };
  });
  view.dispatch(tr, { userEvent: "input" });
  view.focus();
}

/**
 * 行首前缀的开关（标题 / 引用 / 列表）：选区覆盖的每一行都已带这个前缀 → 全部去掉；
 * 否则每行先剥掉同类旧前缀再加上（H2 → H3 是替换，不是叠加）。
 * `prefix(i)` 取第 i 行的前缀，有序列表靠它给递增编号。
 */
export function toggleLinePrefix(
  view: EditorView,
  prefix: (i: number) => string,
  existing: RegExp,
): void {
  const state = view.state;
  const lineNos = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    // 选区止于下一行行首（整行选中的常见形态）时，不把下一行算进去
    const endPos = r.to > r.from && state.doc.lineAt(r.to).from === r.to ? r.to - 1 : r.to;
    const b = state.doc.lineAt(endPos).number;
    for (let n = a; n <= b; n++) lineNos.add(n);
  }
  const lines = [...lineNos].sort((x, y) => x - y).map((n) => state.doc.line(n));

  const allHave = lines.every((l, i) => l.text.startsWith(prefix(i)));
  const changes = lines.map((l, i) => {
    const old = existing.exec(l.text)?.[0] ?? "";
    return allHave
      ? { from: l.from, to: l.from + prefix(i).length, insert: "" }
      : { from: l.from, to: l.from + old.length, insert: prefix(i) };
  });
  view.dispatch({ changes, userEvent: "input" });
  view.focus();
}

/** 链接：有选区就把它当链接文字，并选中 url 占位让人直接粘贴；无选区插一个完整模板。 */
export function insertLink(view: EditorView): void {
  const state = view.state;
  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const label = from === to ? "链接文字" : state.sliceDoc(from, to);
    const url = "https://";
    const insert = `[${label}](${url})`;
    const urlFrom = from + label.length + 3;
    return {
      changes: { from, to, insert },
      range: EditorSelection.range(urlFrom, urlFrom + url.length),
    };
  });
  view.dispatch(tr, { userEvent: "input" });
  view.focus();
}

/** 代码块：有选区就用围栏包住（各占独立行）；无选区插空围栏并把光标放进去。 */
export function insertCodeBlock(view: EditorView): void {
  const state = view.state;
  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const body = state.sliceDoc(from, to);
    const atLineStart = from === state.doc.lineAt(from).from;
    const lead = atLineStart ? "" : "\n";
    const insert = `${lead}\`\`\`\n${body}\n\`\`\`\n`;
    const cursor = from + lead.length + 4 + body.length;
    return { changes: { from, to, insert }, range: EditorSelection.cursor(body ? cursor : from + lead.length + 4) };
  });
  view.dispatch(tr, { userEvent: "input" });
  view.focus();
}

/** 无序 / 有序列表互为同类：从一种切到另一种是替换旧标记，不是叠成「1. - a」。 */
const LIST_MARK = /^(?:[-*+]|\d+\.) /;

export const FORMAT_ACTIONS = {
  bold: (v: EditorView) => toggleWrap(v, "**"),
  italic: (v: EditorView) => toggleWrap(v, "*"),
  code: (v: EditorView) => toggleWrap(v, "`", "`", "代码"),
  link: insertLink,
  h2: (v: EditorView) => toggleLinePrefix(v, () => "## ", /^#{1,6} /),
  h3: (v: EditorView) => toggleLinePrefix(v, () => "### ", /^#{1,6} /),
  quote: (v: EditorView) => toggleLinePrefix(v, () => "> ", /^> ?/),
  ul: (v: EditorView) => toggleLinePrefix(v, () => "- ", LIST_MARK),
  ol: (v: EditorView) => toggleLinePrefix(v, (i) => `${i + 1}. `, LIST_MARK),
  codeBlock: insertCodeBlock,
} as const;

export type FormatAction = keyof typeof FORMAT_ACTIONS;
