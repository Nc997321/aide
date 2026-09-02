/**
 * cmImplGutter —— 「跳转到实现 ↓ / 调用层级 ⇄」gutter 标记扩展（多语言 LSP）。
 *
 * 分层（仿 cmCtrlHover/cmLsp）：StateField<RangeSet<GutterMarker>> 持标记 + ViewPlugin
 * 编排可视区查询 + gutter() 渲染 + baseTheme 样式。扩展不读 settings；opts 由 CodeEditor
 * 传入（workspaceRoot/filePath/lang + 跳转/层级回调）。
 *
 * 行号 gutter 由 basicSetup 提供；本 gutter 自动排其右侧（用户扩展优先级更高）。
 *
 * 编排：可视区行范围变化（滚动）或文档编辑 → debounce 200ms → 取 documentSymbol（缓存）
 *  → 筛可视区声明 → 分批并行查 implementation（缓存）→ 渐进 dispatch setImplMarkers。
 *  - 可调用符号（Method/Constructor/Function，语言无关的 SymbolKind 公共词汇）→ 挂 ⇄
 *    调用层级标记（无查询成本，点击时才走 prepareCallHierarchy）
 *  - Class/Interface/Method/Function 查到实现 → 叠 ↓ 跳实现标记（带缓存 results）
 *  abortToken（自增计数）丢弃滚动中的旧响应。
 *
 * 点击 ↓ → onGotoImplementation 回调（带缓存 results）→ CodeEditor emit("gutter-goto")
 *  → FileWindow jumpOrPick（1 结果直跳，多结果弹 picker）。
 * 点击 ⇄ → onShowCallHierarchy 回调（声明位置）→ CodeEditor emit("gutter-callhierarchy")
 *  → FileWindow → useCallHierarchy().openHierarchy（右侧栏面板换根）。
 *
 * 仅向下箭头（父→子，LSP textDocument/implementation）。向上箭头（子→父）暂未做：无标准
 * LSP go-to-super 请求，跨文件实现类拿不到父接口；要真正可用需 CodeGraph 继承索引，见
 * docs/plans/java-lsp-idea-resilient-anchor.md。
 */
import { StateField, StateEffect, RangeSet, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, gutter, GutterMarker, type ViewUpdate } from "@codemirror/view";
import { api } from "../api";
import type { DocumentSymbolItem, QueryResult } from "../types";

// ── LSP SymbolKind 关注值 ──
// implementation 查询关注（仅这些 kind 的声明值得查）：Class=5, Method=6, Interface=11,
// Function=12（Struct=23 不查——结构体无 implementation 语义）
const RELEVANT_KINDS = new Set([5, 6, 11, 12]);
function isRelevantKind(kind: number): boolean {
  return RELEVANT_KINDS.has(kind);
}

// 调用层级 ⇄ 关注（可调用符号）：Method=6, Constructor=9, Function=12。类/接口是
// 「被引用」而非「被调用」（prepareCallHierarchy 对类返回空）——引用查询走 Alt+Click。
const CALLABLE_KINDS = new Set([6, 9, 12]);
function isCallableKind(kind: number): boolean {
  return CALLABLE_KINDS.has(kind);
}

// ── State 层：标记集合（StateField<RangeSet<GutterMarker>>）──

const setImplMarkers = StateEffect.define<RangeSet<GutterMarker>>();

const implGutterField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setImplMarkers)) return e.value;
    // 文档编辑 → 行号移位，旧标记作废，清空等 tracker 重查后重设
    return tr.docChanged ? RangeSet.empty : val;
  },
});

// ── 标记：⇄ 调用层级（可调用符号）+ ↓ 跳实现（有实现时）──

export interface ImplMarkerData {
  word: string;           // 声明符号名（picker 标题 / 层级根兜底名）
  line: number;           // 标记所在行（1-based，回退 sourceLine 用）
  /** 声明列（1-based）——⇄ 的 prepareCallHierarchy 查询点需要精确位置 */
  column: number;
  /** LSP SymbolKind 原值——决定是否可调用（⇄） */
  kind: number;
  results: QueryResult[]; // 缓存实现列表（空 = 无实现，不显示 ↓）
}

/** ⇄ 点击负载：prepare 查询点（符号声明位置）。filePath 由宿主（FileWindow）自带。 */
export interface GutterCallHierarchyPayload {
  word: string;
  line: number;
  column: number;
}

class ImplMarker extends GutterMarker {
  constructor(
    private data: ImplMarkerData,
    private view: EditorView,
    private onGoto: (payload: GutterGotoPayload) => void,
    private onShowCallHierarchy: (payload: GutterCallHierarchyPayload) => void,
  ) {
    super();
    this.elementClass = "cm-impl-marker";
  }

  eq(other: GutterMarker): boolean {
    // 同行 + 同 results 引用（同一次 fetch 产出）→ 跳过重绘
    return other instanceof ImplMarker
      && this.data.line === other.data.line
      && this.data.results === other.data.results;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-impl-marker-dom";
    // ⇄ 调用层级（可调用符号一律显示；声明位置即 prepare 查询点，点击才发请求）
    if (isCallableKind(this.data.kind)) {
      const callEl = document.createElement("span");
      callEl.className = "cm-call-marker";
      callEl.title = "查看调用层级";
      callEl.textContent = "⇄";
      callEl.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.onShowCallHierarchy({ word: this.data.word, line: this.data.line, column: this.data.column });
      });
      el.appendChild(callEl);
    }
    // ↓ 跳实现（仅查到实现时；带缓存列表免重查）
    if (this.data.results.length > 0) {
      const implEl = document.createElement("span");
      implEl.className = "cm-impl-arrow";
      implEl.title = `跳转到实现（${this.data.results.length} 个）`;
      implEl.textContent = "↓";
      implEl.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // 复刻跳转视口对齐：点击处在编辑器视口的垂直偏移，让目标行落在同高度
        const viewportY = ev.clientY - this.view.scrollDOM.getBoundingClientRect().top;
        // clientX/Y 供宿主把多结果浮层锚定在标记旁（补全式）
        this.onGoto({ ...this.data, viewportY, clientX: ev.clientX, clientY: ev.clientY });
      });
      el.appendChild(implEl);
    }
    return el;
  }
}

export interface GutterGotoPayload extends ImplMarkerData {
  viewportY: number;
  /** 点击坐标（client 系），供结果浮层锚定在标记旁；可选以兼容旧构造方。 */
  clientX?: number;
  clientY?: number;
}

// ── 占位 spacer：固定 gutter 宽度（无标记行也留位，对齐行号 gutter）──

class SpacerMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-impl-marker-dom cm-impl-spacer";
    el.textContent = " ";
    return el;
  }
}
const SPACER = new SpacerMarker();

// ── Event 层：ViewPlugin 编排可视区查询 ──

export interface CmImplGutterOpts {
  workspaceRoot: string;
  filePath: string;
  lang: string;
  onGotoImplementation: (payload: GutterGotoPayload) => void;
  /** ⇄ 点击（调用层级）：声明位置 = prepareCallHierarchy 查询点。 */
  onShowCallHierarchy: (payload: GutterCallHierarchyPayload) => void;
}

class ImplGutterTracker {
  private lastFromLine = 0;
  private lastToLine = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private token = 0; // 自增，丢弃旧响应（Tauri invoke 不可真取消）
  /** documentSymbol 缓存：docChanged 时清空，滚动复用。 */
  private docSymbols: DocumentSymbolItem[] | null = null;
  /** implementation 缓存：key `${line}:${col}`，docChanged 时清空，滚动复用。 */
  private implCache = new Map<string, QueryResult[]>();

  constructor(private view: EditorView, private opts: CmImplGutterOpts) {
    // 初始触发一次（首屏可视区）
    this.schedule(0);
  }

  private schedule(delayMs: number) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.fetchAndRender(), delayMs);
  }

  update(update: ViewUpdate) {
    const vp = update.view.viewport;
    const fromLine = update.view.state.doc.lineAt(vp.from).number;
    const toLine = update.view.state.doc.lineAt(vp.to).number;
    const vpChanged = fromLine !== this.lastFromLine || toLine !== this.lastToLine;
    if (update.docChanged) {
      // 文档编辑 → 行号移位、声明集变化 → 清缓存重查
      this.docSymbols = null;
      this.implCache.clear();
    }
    if (vpChanged || update.docChanged) {
      this.lastFromLine = fromLine;
      this.lastToLine = toLine;
      this.schedule(200);
    }
  }

  private async fetchAndRender() {
    const view = this.view;
    const { workspaceRoot, filePath, lang } = this.opts;
    if (!workspaceRoot || !filePath || !lang) return;
    // >1MB 跳过（与 cmLsp 对齐）
    if (view.state.doc.length > 1_000_000) return;

    const myToken = ++this.token;

    // 1. documentSymbol（缓存命中则免请求）。冷开文件时 jdtls 可能尚未 didOpen/解析，
    //    documentSymbol 返回空——不能缓存空结果（否则卡死，标记永不出现）。
    //    空或错时带退避重试最多 3 次（300/600/900ms），仍空才视为真无符号。
    if (!this.docSymbols) {
      let retries = 0;
      while (retries < 3) {
        let syms: DocumentSymbolItem[] | null = null;
        try {
          syms = await api.lspDocumentSymbol(workspaceRoot, filePath);
          if (myToken !== this.token) return;
        } catch {
          syms = null;
        }
        if (syms && syms.length > 0) { this.docSymbols = syms; break; }
        retries++;
        if (retries >= 3) break;
        await new Promise(r => setTimeout(r, 300 * retries));
        if (myToken !== this.token) return;
      }
      if (!this.docSymbols) this.docSymbols = []; // 重试用尽，视为真无符号
    }
    const symbols = this.docSymbols;

    // 2. 筛可视区声明：implementation 候选（relevant）∪ 调用层级候选（callable）
    const fromLine = view.state.doc.lineAt(view.viewport.from).number;
    const toLine = view.state.doc.lineAt(view.viewport.to).number;
    const visible = symbols.filter(s =>
      s.line >= fromLine && s.line <= toLine
      && (isRelevantKind(s.kind) || isCallableKind(s.kind))
    );

    // 3. implementation 并行查（仅 relevant kind；callable 查询零成本——⇄ 点击才发请求），
    //    每个结果一到就渐进渲染（不串行等批次）。
    //    首个标记 = documentSymbol + 最快那个 implementation；其余随到随显。
    const markersByLine = new Map<number, ImplMarker>();
    await Promise.all(visible.map(async (sym) => {
      const key = `${sym.line}:${sym.column}`;
      let impls: QueryResult[] = [];
      if (isRelevantKind(sym.kind)) {
        let cached = this.implCache.get(key);
        if (!cached) {
          try {
            cached = await api.lspImplementation(workspaceRoot, filePath, sym.line, sym.column, sym.name);
            if (myToken !== this.token) return;
            this.implCache.set(key, cached);
          } catch {
            cached = [];
          }
        }
        impls = cached;
      }
      if (myToken !== this.token) return;
      // 过滤自引用（同文件同行）
      const filtered = impls.filter(r => !(r.symbol.file === filePath && r.symbol.line === sym.line));
      // ⇄（callable）无条件挂；↓ 仅实现非空。两者都无 → 不挂
      if (!isCallableKind(sym.kind) && filtered.length === 0) return;
      markersByLine.set(sym.line, new ImplMarker(
        { word: sym.name, line: sym.line, column: sym.column, kind: sym.kind, results: filtered },
        view, this.opts.onGotoImplementation, this.opts.onShowCallHierarchy,
      ));
      this.flushMarkers(markersByLine);
    }));
  }

  /** 构造 RangeSet 并 dispatch。 */
  private flushMarkers(markersByLine: Map<number, ImplMarker>) {
    const view = this.view;
    const ranges: { pos: number; marker: ImplMarker }[] = [];
    for (const [ln, marker] of markersByLine) {
      const pos = view.state.doc.line(Math.min(ln, view.state.doc.lines)).from;
      ranges.push({ pos, marker });
    }
    ranges.sort((a, b) => a.pos - b.pos);
    const rs = RangeSet.of(ranges.map(r => r.marker.range(r.pos)));
    view.dispatch({ effects: setImplMarkers.of(rs) });
  }

  destroy() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.token++; // 让进行中的 fetch 丢弃
  }
}

// ── gutter + theme ──

const implGutter = gutter({
  class: "cm-impl-gutter",
  markers: (v) => v.state.field(implGutterField, false) ?? RangeSet.empty,
  initialSpacer: () => SPACER,
});

const implGutterTheme = EditorView.baseTheme({
  // 三列 gutter 重排：行号 → 实现/层级箭头 → 折叠三角。.cm-gutters 是 flex 容器，
  // 用 CSS order 重排各 gutter 列，不动扩展顺序（basicSetup 把 lineNumbers/foldGutter
  // 捆在一起、无法用 Prec 插中间）。本主题只在 cmImplGutter 装载时生效——未装载时
  // 无 order 规则，回落默认（行号 → 折叠三角）。
  ".cm-lineNumbers": { order: 0 },
  ".cm-foldGutter": { order: 2 },
  ".cm-impl-gutter": {
    order: 1,
    width: "26px", // ⇄↓ 可能并排（可调用符号带实现）
    // 行号 gutter 已有 border-right，这里不再加；背景与 .cm-gutters 一致（继承）
  },
  ".cm-impl-gutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },
  ".cm-impl-marker-dom": {
    display: "inline-flex",
    alignItems: "center",
    gap: "1px",
  },
  ".cm-impl-marker-dom .cm-call-marker": {
    cursor: "pointer",
    fontSize: "12px",
    lineHeight: 1,
    userSelect: "none",
    color: "var(--aide-accent)",
    transition: "color 0.12s",
  },
  ".cm-impl-marker-dom .cm-call-marker:hover": {
    color: "var(--aide-text-primary)",
  },
  ".cm-impl-marker-dom .cm-impl-arrow": {
    cursor: "pointer",
    fontSize: "13px",
    lineHeight: 1,
    userSelect: "none",
    color: "var(--aide-success)",
    transition: "color 0.12s",
  },
  ".cm-impl-marker-dom .cm-impl-arrow:hover": {
    color: "var(--aide-accent)",
  },
  ".cm-impl-spacer": {
    cursor: "default",
    color: "transparent",
  },
});

// ── Public API ──

export function cmImplGutter(opts: CmImplGutterOpts): Extension {
  if (!opts.workspaceRoot || !opts.filePath || !opts.lang) return [];
  return [
    implGutterField,
    ViewPlugin.fromClass(
      class extends ImplGutterTracker {
        constructor(v: EditorView) { super(v, opts); }
      },
    ),
    implGutter,
    implGutterTheme,
  ];
}