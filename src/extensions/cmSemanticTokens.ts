/**
 * LSP semanticTokens 语义着色（语言无关，随 cmLsp 挂载）。
 *
 * 价值：语法高亮分不清「字段还是方法调用、类型还是参数」，语义 token 按服务器
 * 语义上色。色板与 utils/cmHighlight.ts 的 tag→色映射对齐（function→accent、
 * class→warning、property→info、类型/命名空间→syntaxKeyword、变量→syntaxNumber），
 * 同一符号无论来自语法树还是语义服务器颜色一致；色值走 --aide-* 主题变量。
 *
 * 刷新管道（didChange 防抖 500ms → 全量请求 → 版本比对，过期丢弃重调度）：
 * 该管道为后续 inlayHints 等可视区装饰类扩展复用而设计。
 * 防御：>1MB 跳过；非用户编辑（程序性写入）装饰自清防坐标错位；server 未就绪
 * 静默，初始阶段退避重试 3 次（纯审阅场景无编辑触发，初始重试是唯一通路）。
 */
import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { api } from "../api";
import type { SemanticToken } from "../types";
import { isUserEdit } from "../utils/cmModelSync";

// ── 颜色映射：tokenType → class ──

/** 只对有语义增益的类型着色：keyword/string/number/comment 等语法高亮
 * （Lezer + cmHighlight）已覆盖，语义重复上色无增益，直接跳过。 */
const COLORABLE_TYPES: Record<string, string> = {
  function: "aide-st-fn",
  method: "aide-st-fn",
  event: "aide-st-fn",
  class: "aide-st-type",
  struct: "aide-st-type",
  enum: "aide-st-type",
  interface: "aide-st-type",
  type: "aide-st-ns",
  typeParameter: "aide-st-ns",
  namespace: "aide-st-ns",
  macro: "aide-st-ns",
  property: "aide-st-prop",
  variable: "aide-st-var",
  parameter: "aide-st-var",
  enumMember: "aide-st-var",
};

/** semantic tokens → CM mark 装饰区间（纯函数，可单测）。输入 line 1-based、
 *  startChar 0-based（与 SDK SemanticToken 约定一致）。防御：越界行跳过、to
 *  clamp 到行尾、区间交叠跳过（RangeSet 不容部分交叠）、deprecated 修饰符
 *  追加删除线 class。输出保证 from 有序（server 乱序返回时先排序）。 */
export function tokenRanges(tokens: SemanticToken[], doc: Text): Range<Decoration>[] {
  const sorted = [...tokens].sort((a, b) => a.line - b.line || a.startChar - b.startChar);
  const out: Range<Decoration>[] = [];
  let lastTo = -1;
  for (const t of sorted) {
    const cls = COLORABLE_TYPES[t.tokenType];
    if (!cls) continue;
    if (t.line < 1 || t.line > doc.lines) continue;
    const line = doc.line(t.line);
    const from = line.from + t.startChar;
    if (from >= line.to) continue;
    const to = Math.min(from + t.length, line.to);
    if (to <= from || from < lastTo) continue;
    const classes = t.tokenModifiers?.includes("deprecated")
      ? `${cls} aide-stm-deprecated`
      : cls;
    out.push(Decoration.mark({ class: classes }).range(from, to));
    lastTo = to;
  }
  return out;
}

// ── State 层：装饰集（docChanged 自清——装饰坐标基于绝对 pos，文档一变即
// 错位，清空等防抖重刷，比映射错位闪烁好）──

const setDecos = StateEffect.define<DecorationSet>();

const decoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setDecos)) return e.value;
    return tr.docChanged ? Decoration.none : val;
  },
});

// ── Event 层：ViewPlugin（初始请求 + didChange 防抖刷新 + 版本比对）──

class SemanticTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** doc 版本（每次 docChanged 自增）：请求发起时快照，响应回来比对——
   *  过期响应丢弃并重调度，避免把旧坐标装饰套在新 doc 上。 */
  private version = 0;
  /** 初始重试计数（1s/4s/9s 退避）：server 握手/索引期请求空或失败时重试，
   *  纯审阅场景（打开不编辑）无编辑触发，初始重试是唯一通路。 */
  private retries = 0;
  private readonly view: EditorView;
  private readonly opts: { workspaceRoot: string; filePath: string; lang: string };

  constructor(view: EditorView, opts: { workspaceRoot: string; filePath: string; lang: string }) {
    this.view = view;
    this.opts = opts;
    // 构造发生在 EditorView update 流程内，dispatch 被禁止——推迟微任务再请求。
    queueMicrotask(() => { if (!this.destroyed) void this.request(); });
  }

  update(u: ViewUpdate) {
    if (!u.docChanged) return;
    this.version++;
    if (isUserEdit(u.transactions)) this.schedule();
    // 非用户编辑（程序性写入）：decoField 在 docChanged 时已自清，
    // 等下次用户编辑触发刷新。
  }

  private schedule() {
    if (this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.request(), 500);
  }

  private maybeRetry() {
    if (this.destroyed || this.retries >= 3) return;
    const delay = [1000, 4000, 9000][this.retries];
    this.retries++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.request(), delay);
  }

  private async request(): Promise<void> {
    const { workspaceRoot, filePath, lang } = this.opts;
    if (this.destroyed || !workspaceRoot || !lang) return;
    const st = this.view.state;
    if (st.doc.length > 1_000_000) return;
    const v = this.version;
    try {
      // 先同步 doc 再请求（同补全源策略）：server 串行处理，看到最新 doc 才算
      // token；防抖 500ms > cmLsp 的 didChange 300ms，正常时序已同步，此处兜底。
      await api.lspDidChange(workspaceRoot, filePath, lang, st.doc.toString());
      const tokens = await api.lspSemanticTokens(workspaceRoot, filePath);
      if (this.destroyed) return;
      if (v !== this.version) {
        // 编辑风暴中响应过期：丢弃（旧坐标装饰套新 doc 会错位），防抖重请求。
        this.schedule();
        return;
      }
      if (tokens.length) {
        this.retries = 0;
      } else {
        // 空 = 未就绪/索引期/无 token 三合一：可能是索引期暂态，退避重试。
        this.maybeRetry();
      }
      this.view.dispatch({
        effects: setDecos.of(Decoration.set(tokenRanges(tokens, this.view.state.doc))),
      });
    } catch {
      // server 未就绪/失败：静默（不阻塞编辑器），初始阶段退避重试。
      this.maybeRetry();
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

// ── Public API ──

export function cmSemanticTokens(opts: { workspaceRoot: string; filePath: string; lang: string }): Extension {
  return [
    decoField,
    ViewPlugin.fromClass(
      class extends SemanticTracker {
        constructor(v: EditorView) { super(v, opts); }
      },
    ),
    EditorView.baseTheme({
      // !important：语义装饰 span 与 Lezer 语法高亮 span 同为 mark 装饰、嵌套
      // 顺序不定，必须压过语法高亮类的 color——语义 token 优先于语法 token。
      ".cm-content .aide-st-fn": { color: "var(--aide-accent) !important" },
      ".cm-content .aide-st-type": { color: "var(--aide-warning) !important" },
      ".cm-content .aide-st-ns": { color: "var(--aide-syntax-keyword) !important" },
      ".cm-content .aide-st-prop": { color: "var(--aide-info) !important" },
      ".cm-content .aide-st-var": { color: "var(--aide-syntax-number) !important" },
      ".cm-content .aide-stm-deprecated": { textDecoration: "line-through" },
    }),
  ];
}
