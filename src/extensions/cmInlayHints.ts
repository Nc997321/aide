/**
 * LSP inlayHints 参数名/类型提示（语言无关，随 cmLsp 挂载）。
 *
 * 价值：`foo(x, 42)` 直接看到 `x: count: i32, 42: i32`；`let n = calc()` 看到
 * `n: usize`——审阅陌生代码时不用跳定义即可读懂形参语义与推导类型。
 *
 * 与 semanticTokens 的管道差异：协议 params 必带 range → 只请求可视区行范围
 * （±10 行缓冲），滚动即按新范围重发（250ms 防抖）；编辑照旧 500ms 防抖 +
 * 版本比对过期丢弃。>1MB 跳过；程序性写入装饰自清；初始退避重试 3 次
 * （纯审阅场景无编辑触发）；初始 viewport 未 measure 时是全 doc，clamp 到
 * 前 300 行防大文档首请求全量。
 *
 * 渲染：position 语义 = hint 文本插入点（server 归一，前端不猜语义）——
 * param 缀于实参前、type 缀于名字后。样式走 --aide-text-muted 主题变量
 * （斜体弱化，不与正文争夺注意力）。
 */
import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { api } from "../api";
import type { InlayHintItem } from "../types";
import { isUserEdit } from "../utils/cmModelSync";

// ── widget：hint 文本节点 ──

/** 导出供测试引用（实例经 Decoration spec.widget 本就是公开访问面）。 */
export class InlayHintWidget extends WidgetType {
  constructor(readonly hint: InlayHintItem) {
    super();
  }

  eq(other: InlayHintWidget): boolean {
    return (
      this.hint.kind === other.hint.kind
      && this.hint.label === other.hint.label
      && this.hint.paddingLeft === other.hint.paddingLeft
      && this.hint.paddingRight === other.hint.paddingRight
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className =
      "cm-inlayHint"
      + (this.hint.paddingLeft ? " cm-inlayHint-padL" : "")
      + (this.hint.paddingRight ? " cm-inlayHint-padR" : "");
    span.textContent = this.hint.label;
    return span;
  }

  // v1 无交互（click-to-insert 待协议 textEdits 消费）：吞掉事件防误聚焦。
  ignoreEvent(): boolean {
    return true;
  }
}

/** inlay hints → CM point widget 装饰（纯函数，可单测）。输入 line/column
 *  1-based（与 SDK InlayHintItem 约定一致），position = 插入点：widget 挂该
 *  边界即渲染在 param 实参前 / type 名字后。side：param=-1（与行首光标共处时
 *  排光标前不遮挡）、type=1。防御：越界行/空 label 跳过；column clamp 到行尾
 *  （type hint position 常指行尾）。输出按 pos 有序（server 乱序返回先排序）。 */
export function hintWidgets(hints: InlayHintItem[], doc: Text): Range<Decoration>[] {
  const sorted = [...hints].sort((a, b) => a.line - b.line || a.column - b.column);
  const out: Range<Decoration>[] = [];
  for (const h of sorted) {
    if (h.line < 1 || h.line > doc.lines) continue;
    if (!h.label) continue;
    const line = doc.line(h.line);
    const pos = Math.min(line.from + h.column - 1, line.to);
    out.push(
      Decoration.widget({
        widget: new InlayHintWidget(h),
        side: h.kind === "param" ? -1 : 1,
      }).range(pos),
    );
  }
  return out;
}

// ── State 层：装饰集（docChanged 自清——widget 坐标基于绝对 pos，文档一变即
// 错位，清空等防抖重刷，比映射错位闪烁好；同 semanticTokens 策略）──

const setDecos = StateEffect.define<DecorationSet>();

const decoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setDecos)) return e.value;
    return tr.docChanged ? Decoration.none : val;
  },
});

// ── Event 层：ViewPlugin（初始 + 编辑防抖 + 滚动范围跟踪 + 版本比对）──

/** 可视区外扩行数：滚动平滑过渡（缓冲区内的 hint 已就位，不逐行重发）。 */
const VIEWPORT_PAD = 10;
/** 初始请求行数上限：初始 viewport 未 measure 是全 doc，clamp 防大文档首请求
 *  全量（server 需算完整个区间才返回，10k 行秒级卡顿）。measure 后的首次
 *  viewportChanged 会按真实可视区重发修正。 */
const INITIAL_MAX_LINE = 300;

class InlayTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** doc 版本（docChanged 自增）：请求快照，响应回来比对——过期丢弃重调度。 */
  private version = 0;
  /** 初始重试计数（1s/4s/9s 退避）：server 握手/索引期空响应时重试。 */
  private retries = 0;
  /** doc 脏标（编辑后首次请求前同步 didChange；滚动触发的请求零同步开销——
   *  滚动时 doc 未变，全量文本重发纯浪费）。cmLsp didOpen 已同步初始文本。 */
  private dirty = false;
  /** 上次请求的行范围（含缓冲）：滚动后范围未变不重发。 */
  private lastFrom = 0;
  private lastTo = 0;
  /** 初始请求是否已发出（初始 range clamp 只对首请求生效）。 */
  private initialSent = false;
  private readonly view: EditorView;
  private readonly opts: { workspaceRoot: string; filePath: string; lang: string };

  constructor(view: EditorView, opts: { workspaceRoot: string; filePath: string; lang: string }) {
    this.view = view;
    this.opts = opts;
    // 构造发生在 EditorView update 流程内，dispatch 被禁止——推迟微任务再请求。
    queueMicrotask(() => { if (!this.destroyed) void this.request(); });
  }

  update(u: ViewUpdate) {
    if (u.docChanged) {
      this.version++;
      this.dirty = true;
      if (isUserEdit(u.transactions)) this.schedule(500);
      // 程序性写入：decoField 在 docChanged 时已自清，等下次用户编辑触发刷新。
      return;
    }
    if (u.viewportChanged) {
      // 滚动（含初始 measure）：可视区行范围（含缓冲）与上次请求不同才重发。
      const { from, to } = this.visibleRange();
      if (from !== this.lastFrom || to !== this.lastTo) this.schedule(250);
    }
  }

  /** 可视区行范围（1-based 含头含尾）± VIEWPORT_PAD 缓冲。 */
  private visibleRange(): { from: number; to: number } {
    const doc = this.view.state.doc;
    const vp = this.view.viewport;
    const from = Math.max(1, doc.lineAt(vp.from).number - VIEWPORT_PAD);
    const to = Math.min(doc.lines, doc.lineAt(vp.to).number + VIEWPORT_PAD);
    return { from, to };
  }

  private schedule(delay: number) {
    if (this.destroyed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.request(), delay);
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
    const { from, to } = this.visibleRange();
    const reqTo = this.initialSent ? to : Math.min(to, INITIAL_MAX_LINE);
    const v = this.version;
    try {
      if (this.dirty) {
        // 编辑后首次请求：先同步 doc 再请求（同补全源策略——防抖 500ms 期间
        // cmLsp 的 didChange 300ms 已先发，此处兜底「先 doc 后 hint」时序）。
        await api.lspDidChange(workspaceRoot, filePath, lang, st.doc.toString());
        this.dirty = false;
      }
      const hints = await api.lspInlayHints(workspaceRoot, filePath, from, reqTo);
      if (this.destroyed) return;
      this.initialSent = true;
      this.lastFrom = from;
      this.lastTo = reqTo;
      if (v !== this.version) {
        // 编辑风暴中响应过期：丢弃（旧坐标装饰套新 doc 会错位），防抖重请求。
        this.schedule(500);
        return;
      }
      if (hints.length) {
        this.retries = 0;
      } else {
        // 空 = 未就绪/该区无 hint 三合一：可能是索引期暂态，退避重试。
        this.maybeRetry();
      }
      this.view.dispatch({
        effects: setDecos.of(Decoration.set(hintWidgets(hints, this.view.state.doc))),
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

export function cmInlayHints(opts: { workspaceRoot: string; filePath: string; lang: string }): Extension {
  return [
    decoField,
    ViewPlugin.fromClass(
      class extends InlayTracker {
        constructor(v: EditorView) { super(v, opts); }
      },
    ),
    EditorView.baseTheme({
      // inlay hint 惯例：弱化色 + 斜体 + 小一号，明确「非源码文本」。
      // pointer-events none：不挡编辑器点击/选择（v1 无交互）。
      ".cm-content .cm-inlayHint": {
        color: "var(--aide-text-muted)",
        fontSize: "0.85em",
        fontStyle: "italic",
        userSelect: "none",
        pointerEvents: "none",
      },
      ".cm-content .cm-inlayHint-padL": { paddingLeft: "4px" },
      ".cm-content .cm-inlayHint-padR": { paddingRight: "4px" },
    }),
  ];
}
