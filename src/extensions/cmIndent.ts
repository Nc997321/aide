/**
 * cmIndent —— CodeMirror 缩进扩展（由编辑器设置驱动）。
 *
 * 分层：本文件只产 CodeMirror 扩展，不读 settings；调用方（CodeEditor）传 IndentConfig 进来，
 * 用 compartment 包住以便设置变化时 reconfigure。CM 的 `indentUnit` 决定回车自动缩进
 * 与 Tab 插入的字符串，`tabSize` 决定 Tab 字符的显示列宽。
 *
 * 缩进字符固定为 Tab（\t）：回车自动缩进、Tab 键都插入 \t，显示宽度由 indentSize（tabSize）决定。
 * 不再提供空格/Tab 切换——统一 Tab 缩进，避免历史配置残留导致行为不一致。
 *
 * 为什么不直接用 @codemirror/commands 的 indentWithTab？
 * —— `@codemirror/commands` 是 `codemirror` 元包的传递依赖，pnpm 下项目源码无法直接 import；
 *   且 basicSetup / defaultKeymap 都不绑定 Tab。故在此自实现 Tab/Shift-Tab handler，
 *   行为与 indentWithTab 等价（Tab=缩进，Shift-Tab=反缩进）。
 */
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";

export interface IndentConfig {
  /** Tab 字符的显示列宽（回车自动缩进与 Tab 键每层插入一个 \t），>=1 */
  indentSize: number;
}

/** 一层缩进的字符串——固定单个 Tab 字符。 */
const INDENT_UNIT = "\t";

/**
 * Tab：无选区或单行选区→在光标处插入一层缩进（\t）；跨行选区→每行行首加一层缩进。
 * 返回 true 表示已处理，阻止浏览器默认 Tab 行为（焦点跳转）。
 */
function tabMore(view: EditorView): boolean {
  const { state } = view;
  const multiline = state.selection.ranges.some(
    (r) => state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number
  );
  if (!multiline) {
    // 纯插入：每个选区范围替换为一个 Tab（有选区时覆盖选中内容）
    const changes = state.changeByRange((r) => ({
      changes: { from: r.from, to: r.to, insert: INDENT_UNIT },
      range: EditorSelection.cursor(r.from + INDENT_UNIT.length),
    }));
    view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input.indent" }));
    return true;
  }
  // 跨行：对每个涉及行行首插入一个 Tab
  const lines = collectLines(state);
  const changes = lines.map((ln) => ({ from: state.doc.line(ln).from, insert: INDENT_UNIT }));
  view.dispatch({ changes, userEvent: "input.indent" });
  return true;
}

/**
 * Shift-Tab：对每个涉及行行首去掉一层缩进——先吃一个 Tab，没有则吃至多 size 个行首空格
 * （兼容历史用空格缩进的文件）。
 */
function tabLess(view: EditorView, size: number): boolean {
  const { state } = view;
  const lines = collectLines(state);
  const changes: { from: number; to: number; insert: string }[] = [];
  for (const ln of lines) {
    const line = state.doc.line(ln);
    const text = line.text;
    let remove = 0;
    if (text.startsWith("\t")) remove = 1;
    else { let i = 0; while (i < size && text[i] === " ") i++; remove = i; }
    if (remove > 0) changes.push({ from: line.from, to: line.from + remove, insert: "" });
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: "delete.indent" });
  return true;
}

/** 收集当前选区涉及的所有行号（去重升序）。 */
function collectLines(state: EditorState): number[] {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return [...set].sort((x, y) => x - y);
}

/** 构造缩进扩展：indentUnit（\t）+ tabSize + Tab/Shift-Tab 键映射。 */
export function cmIndent(cfg: IndentConfig): Extension {
  const size = Math.max(1, Math.floor(cfg.indentSize) || 1);
  return [
    indentUnit.of(INDENT_UNIT),
    EditorState.tabSize.of(size),
    keymap.of([
      {
        key: "Tab",
        run: tabMore,
        shift: (v) => tabLess(v, size),
        preventDefault: true,
      },
    ]),
  ];
}