/**
 * LSP signatureHelp 参数提示（语言无关，随 cmLsp 挂载）。
 *
 * 触发：用户输入 `(` 或 `,`（防抖 150ms，先同步 doc 再请求——与补全源同策略，
 * 保证 server 看到刚输入的触发字符）。关闭：输入 `)` / Esc / 光标移走。
 * 渲染：tooltip 锚在光标处上方；当前激活参数高亮（label 按顶层逗号切分，
 * 忽略 ()/[]/<> 内的逗号，兼容 Java 泛型与数组类型）；多重重载显示 n/m 计数；
 * 激活参数带文档时在签名下方渲染 markdown。
 *
 * 与 cmLsp 同约束：>1MB 跳过、server 未就绪/失败静默（不阻塞输入）。
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type ViewUpdate } from "@codemirror/view";
import { api } from "../api";
import type { SignatureHelpResult } from "../types";
import { isUserEdit } from "../utils/cmModelSync";
import { renderMarkdown } from "../utils/markdown";

interface SigState {
  /** tooltip 锚点（请求时光标位置）。 */
  pos: number;
  sig: SignatureHelpResult;
}

const setSignature = StateEffect.define<SigState | null>();

const sigField = StateField.define<SigState | null>({
  create: () => null,
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setSignature)) return e.value;
    return val;
  },
  provide: (f) =>
    showTooltip.compute([f], (s) => {
      const st = s.field(f, false);
      if (!st) return null;
      return {
        pos: st.pos,
        above: true,
        class: "aide-lsp-signature-tooltip",
        create: () => ({ dom: renderSignature(st.sig) }),
      };
    }),
});

/** label 按顶层逗号切分出参数 span（忽略 ()/[]/<> 括号深度内的逗号）。 */
function paramSpans(label: string): { start: number; end: number }[] {
  const open = label.indexOf("(");
  if (open < 0) return [];
  let close = -1;
  let depth = 0;
  for (let i = open; i < label.length; i++) {
    if (label[i] === "(") depth++;
    else if (label[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [];
  const spans: { start: number; end: number }[] = [];
  let d = 0;
  let segStart = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const c = label[i];
    if (c === "(" || c === "[" || c === "<") d++;
    else if (c === ")" || c === "]" || c === ">") d--;
    else if ((c === "," && d === 0) || i === close) {
      const end = i === close ? close : i;
      if (end > segStart) spans.push({ start: segStart, end });
      segStart = i + 1;
    }
  }
  return spans;
}

function renderSignature(r: SignatureHelpResult): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "aide-lsp-signature";
  const idx = Math.min(r.activeSignature ?? 0, r.signatures.length - 1);
  const sig = r.signatures[idx];
  if (!sig) return dom;
  const activeParam = sig.activeParameter ?? r.activeParameter ?? null;

  const label = document.createElement("div");
  label.className = "aide-lsp-signature-label";
  const spans = paramSpans(sig.label);
  let cursor = 0;
  const push = (from: number, to: number, cls?: string) => {
    if (to <= from) return;
    if (cls) {
      const b = document.createElement("span");
      b.className = cls;
      b.textContent = sig.label.slice(from, to);
      label.appendChild(b);
    } else {
      label.appendChild(document.createTextNode(sig.label.slice(from, to)));
    }
    cursor = to;
  };
  spans.forEach((sp, i) => {
    push(cursor, sp.start);
    push(sp.start, sp.end, i === activeParam ? "aide-lsp-signature-param is-active" : "aide-lsp-signature-param");
  });
  push(cursor, sig.label.length);
  dom.appendChild(label);

  if (r.signatures.length > 1) {
    const count = document.createElement("div");
    count.className = "aide-lsp-signature-count";
    count.textContent = `${idx + 1}/${r.signatures.length}`;
    dom.appendChild(count);
  }
  const p = activeParam != null ? sig.parameters[activeParam] : null;
  if (p?.documentation) {
    const doc = document.createElement("div");
    doc.className = "aide-lsp-signature-doc";
    doc.innerHTML = renderMarkdown(p.documentation);
    dom.appendChild(doc);
  }
  return dom;
}

class SigTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly view: EditorView;
  private readonly opts: { workspaceRoot: string; filePath: string; lang: string };

  constructor(view: EditorView, opts: { workspaceRoot: string; filePath: string; lang: string }) {
    this.view = view;
    this.opts = opts;
  }

  update(u: ViewUpdate) {
    // 光标移走（纯 selection 变更）→ 关闭提示
    if (u.selectionSet && !u.docChanged && this.view.state.field(sigField, false)) {
      this.view.dispatch({ effects: setSignature.of(null) });
      return;
    }
    if (!u.docChanged || !isUserEdit(u.transactions)) return;
    let trigger: "on" | "off" | null = null;
    u.changes.iterChanges((_fa, _ta, _fb, _tb, inserted) => {
      const last = inserted.toString().slice(-1);
      if (last === "(" || last === ",") trigger = "on";
      else if (last === ")") trigger = "off";
    });
    if (trigger === "off") {
      this.view.dispatch({ effects: setSignature.of(null) });
      return;
    }
    if (trigger !== "on") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.request(), 150);
  }

  private async request() {
    if (this.destroyed) return;
    const { workspaceRoot, filePath, lang } = this.opts;
    if (!workspaceRoot || !lang) return;
    const st = this.view.state;
    if (st.doc.length > 1_000_000) return;
    const pos = st.selection.main.head;
    const line = st.doc.lineAt(pos);
    try {
      // 先同步 doc 再请求（同补全源策略）：server 按序处理，看到触发字符才算调用上下文
      await api.lspDidChange(workspaceRoot, filePath, lang, st.doc.toString());
      const r = await api.lspSignatureHelp(workspaceRoot, filePath, line.number, pos - line.from + 1);
      if (this.destroyed) return;
      if (!r || !r.signatures?.length) {
        this.view.dispatch({ effects: setSignature.of(null) });
        return;
      }
      this.view.dispatch({ effects: setSignature.of({ pos, sig: r }) });
    } catch {
      // server 未就绪/失败：静默（不阻塞输入）
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

export function cmSignatureHelp(opts: { workspaceRoot: string; filePath: string; lang: string }): Extension {
  return [
    sigField,
    keymap.of([
      {
        key: "Escape",
        run: (v) => {
          if (!v.state.field(sigField, false)) return false;
          v.dispatch({ effects: setSignature.of(null) });
          return true;
        },
      },
    ]),
    ViewPlugin.fromClass(
      class extends SigTracker {
        constructor(v: EditorView) {
          super(v, opts);
        }
      },
    ),
    EditorView.baseTheme({
      ".cm-tooltip.aide-lsp-signature-tooltip": {
        border: "1px solid var(--border-2, #444)",
        borderRadius: "4px",
        backgroundColor: "var(--bg-2, #262626)",
        color: "var(--text-1, #ddd)",
        padding: "4px 8px",
        fontSize: "12.5px",
        fontFamily: "inherit",
      },
      ".aide-lsp-signature": { maxWidth: "560px", lineHeight: "1.5" },
      ".aide-lsp-signature-label": {
        fontFamily: "var(--mono, ui-monospace, monospace)",
        whiteSpace: "pre-wrap",
      },
      ".aide-lsp-signature-param": { opacity: "0.55" },
      ".aide-lsp-signature-param.is-active": {
        opacity: "1",
        fontWeight: "600",
        borderBottom: "1px solid currentColor",
      },
      ".aide-lsp-signature-count": { opacity: "0.5", fontSize: "11px", marginTop: "2px" },
      ".aide-lsp-signature-doc": {
        marginTop: "4px",
        paddingTop: "4px",
        borderTop: "1px solid var(--border-1, #333)",
        maxWidth: "480px",
        fontSize: "12px",
      },
    }),
  ];
}
