import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type Tooltip } from "@codemirror/view";
import { autocompletion } from "@codemirror/autocomplete";
import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { api } from "../api";
import { useLsp, type LspDiagnostic } from "../composables/useLsp";
import { isUserEdit } from "../utils/cmModelSync";
import { renderMarkdown } from "../utils/markdown";

// ── State 层：诊断（来自 useLsp，按 filePath 过滤后注入 CM）──

const setDiagnostics = StateEffect.define<LspDiagnostic[]>();

const diagField = StateField.define<LspDiagnostic[]>({
  create: () => [],
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setDiagnostics)) return e.value;
    return val;
  },
});

// ── Event 层：ViewPlugin（didOpen/didClose + didChange debounce + 同步诊断）──

class LspTracker {
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly view: EditorView;
  private readonly opts: CmLspOpts;

  constructor(view: EditorView, opts: CmLspOpts) {
    this.view = view;
    this.opts = opts;
    if (opts.enabled) this.didOpen();
  }

  private async didOpen() {
    const { workspaceRoot, lang, filePath } = this.opts;
    if (!workspaceRoot || !lang) return;
    const text = this.view.state.doc.toString();
    // >1MB skip guard: 超大文件不走 LSP（spec §7 贯穿约束）
    if (text.length > 1_000_000) return;
    try { await api.lspDidOpen(workspaceRoot, filePath, lang, text); } catch { /* server not ready */ }
  }

  private async didChange() {
    const { workspaceRoot, lang, filePath } = this.opts;
    if (!workspaceRoot || !lang) return;
    const text = this.view.state.doc.toString();
    // >1MB skip guard
    if (text.length > 1_000_000) return;
    try { await api.lspDidChange(workspaceRoot, filePath, lang, text); } catch { /* ignore */ }
  }

  update(update: any) {
    if (update.docChanged && isUserEdit(update.transactions)) {
      // debounce 300ms（spec §5.2）
      if (this.changeTimer) clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => this.didChange(), 300);
    }
  }

  destroy() {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    const { workspaceRoot, lang, filePath } = this.opts;
    if (this.opts.enabled) {
      api.lspDidClose(workspaceRoot, filePath, lang).catch(() => {});
    }
  }
}

// ── 三个 source：autocompletion / linter / hoverTooltip ──

function lspCompletionSource(workspaceRoot: string, filePath: string, lang: string) {
  return async (ctx: any): Promise<any> => {
    if (!workspaceRoot || (!ctx.explicit && ctx.state.doc.length === 0)) return null;
    const pos = ctx.pos;
    const line = ctx.state.doc.lineAt(pos);
    const lineNum = line.number - 1;            // 0-based
    const col = pos - line.from;                // 0-based
    try {
      const items = await api.lspCompletion(workspaceRoot, filePath, lineNum + 1, col + 1);
      if (!items.length) return null;
      return {
        from: ctx.pos,
        options: items.map((it) => ({
          label: it.insert_text || it.label,
          detail: it.detail,
          info: it.documentation ? () => renderMarkdown(it.documentation!) : undefined,
          type: completionKind(it.kind),
        })),
      };
    } catch { return null; }
  };
}

function completionKind(k?: number): string {
  // LSP CompletionItemKind → CM tag（简化）
  if (k === 3 || k === 12) return "function";   // Function / Value
  if (k === 6 || k === 23) return "variable";   // Variable
  if (k === 5 || k === 22) return "class";      // Class / Struct
  if (k === 8 || k === 9) return "namespace";   // Enum / Module
  return "variable";
}

function lspLinter(workspaceRoot: string, filePath: string) {
  return linter((view) => {
    if (!workspaceRoot) return [];
    const diags: LspDiagnostic[] = useLsp().diagnosticsFor(filePath);
    return diags.map<CmDiagnostic>((d) => {
      const line = view.state.doc.line(Math.min(d.fromLine + 1, view.state.doc.lines));
      const from = Math.min(line.from + d.fromCol, line.to);
      const to = Math.min(line.from + d.toCol, line.to);
      return {
        from, to,
        severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
        message: d.message,
      };
    });
  });
}

function lspHover(workspaceRoot: string, filePath: string) {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    if (!workspaceRoot) return null;
    const line = view.state.doc.lineAt(pos);
    const lineNum = line.number - 1;
    const col = pos - line.from;
    try {
      const { content } = await api.lspHover(workspaceRoot, filePath, lineNum + 1, col + 1);
      if (!content) return null;
      return {
        pos,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "aide-lsp-hover";
          dom.innerHTML = renderMarkdown(content);
          return { dom };
        },
      };
    } catch { return null; }
  });
}

// ── Public API ──

export interface CmLspOpts {
  workspaceRoot: string;
  enabled: boolean;
  lang: string;
  filePath: string;
}

export function cmLsp(opts: CmLspOpts): Extension {
  if (!opts.enabled) {
    // 关闭：返回空扩展（不发 didOpen/didChange，不挂任何扩展）。
    return [];
  }
  const plugin = ViewPlugin.fromClass(
    class extends LspTracker { constructor(v: EditorView) { super(v, opts); } },
    { provide: () => [lspLinter(opts.workspaceRoot, opts.filePath)] },
  );
  return [
    diagField,
    plugin,
    autocompletion({ override: [lspCompletionSource(opts.workspaceRoot, opts.filePath, opts.lang)], activateOnTyping: true }),
    lspHover(opts.workspaceRoot, opts.filePath),
    EditorView.baseTheme({
      ".aide-lsp-hover": {
        maxWidth: "480px", padding: "6px 10px",
        fontSize: "12.5px", lineHeight: "1.5",
      },
      ".aide-lsp-hover pre": { margin: "4px 0", padding: "6px", overflow: "auto" },
    }),
  ];
}
