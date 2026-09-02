import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { linter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { watch, type WatchStopHandle } from "vue";
import { api } from "../api";
import { useLsp, type LspDiagnostic } from "../composables/useLsp";
import { cmSignatureHelp } from "./cmSignatureHelp";
import { isUserEdit } from "../utils/cmModelSync";
import { renderMarkdown } from "../utils/markdown";

// ── State 层：诊断（来自 useLsp，按 filePath 过滤后注入 CM）──

const setDiagnostics = StateEffect.define<LspDiagnostic[]>();

/** 诊断 Map 按 filePath 取值（key 统一正斜杠比较——Map key 来自 uriToPath
 *  （file:///C:/x → C:/x），编辑器 filePath 可能是反斜杠 C:\x）。 */
function diagsForPath(map: Map<string, LspDiagnostic[]>, filePath: string): LspDiagnostic[] {
  const key = filePath.replace(/\\/g, "/");
  const direct = map.get(key);
  if (direct) return direct;
  for (const [k, v] of map) {
    if (k.replace(/\\/g, "/") === key) return v;
  }
  return [];
}

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
  private unwatch: WatchStopHandle | null = null;
  private destroyed = false;

  constructor(view: EditorView, opts: CmLspOpts) {
    this.view = view;
    this.opts = opts;
    if (opts.enabled) this.didOpen();
    // 初始注入：diagnostics 可能已存在（重开文件 / server 已发布过），watch 只
    // 监听后续变化，构造时补一次。空数组跳过，避免无谓的初始事务。
    // 注意：插件构造发生在 EditorView update 流程中，此时 dispatch 被禁止
    // （"Calls to EditorView.update are not allowed while an update is in progress"）
    // ——推迟到当前 update 完成（微任务）再注入。
    if (opts.enabled && opts.filePath) {
      const initial = diagsForPath(useLsp().diagnostics.value, opts.filePath);
      if (initial.length) {
        queueMicrotask(() => {
          if (!this.destroyed) view.dispatch({ effects: setDiagnostics.of(initial) });
        });
      }
    }
    // spec §7 flow 1：publishDiagnostics 在 doc 未变时到达（"打开文件看到既有
    // 错误"），linter() 只在编辑事务时重跑——此处订阅 useLsp().diagnostics 的
    // Map 变化，把对应 filePath 的诊断 dispatch 进 diagField；linter 通过
    // needsRefresh 感知该 effect 并重画波浪线，无需用户输入。
    this.unwatch = watch(
      () => useLsp().diagnostics.value,
      (map) => {
        if (this.destroyed || !this.opts.enabled || !this.opts.filePath) return;
        const diags = diagsForPath(map, this.opts.filePath);
        this.view.dispatch({ effects: setDiagnostics.of(diags) });
      },
    );
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
    try {
      await api.lspDidChange(workspaceRoot, filePath, lang, text);
    } catch (e) {
      // server 未就绪/已停时变更同步失败是预期路径：编辑器不受影响，下次变更
      // 或补全请求前（lspCompletionSource 会先同步 doc）会重试，这里只落日志
      console.warn("[cmLsp] didChange 同步失败:", e);
    }
  }

  update(update: ViewUpdate) {
    if (update.docChanged && isUserEdit(update.transactions)) {
      // debounce 300ms（spec §5.2）
      if (this.changeTimer) clearTimeout(this.changeTimer);
      this.changeTimer = setTimeout(() => this.didChange(), 300);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.unwatch?.();
    this.unwatch = null;
    // 不发 didClose：导航会重建 CodeEditor（destroy 旧 + create 新），若 didClose 再 didOpen
    // 会让 jdtls 重新解析导入绑定（异步、秒级），回退后立刻跳转拿到空定义（降级）。
    // 改为文档在 jdtls 里保持打开，lsp_did_open 去重已开文档；关 LSP 时 lspShutdownWorkspace
    // 杀 jdtls 自然丢全部文档。（代价：jdtls 累积打开文档直到关 LSP/退出，可接受）
  }
}

// ── 三个 source：autocompletion / linter / hoverTooltip ──

function lspCompletionSource(workspaceRoot: string, filePath: string, lang: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!workspaceRoot || (!ctx.explicit && ctx.state.doc.length === 0)) return null;
    // 自动触发守卫：仅当前驱字符是词字符或成员触发符 . 才弹补全；空格/标点/换行
    // 不触发（函数内按空格不应弹列表）。显式触发（Ctrl+Space，ctx.explicit）放行。
    if (!ctx.explicit) {
      const before = ctx.state.doc.sliceString(Math.max(0, ctx.pos - 1), ctx.pos);
      if (!/[\w.]/.test(before)) return null;
    }
    const pos = ctx.pos;
    const line = ctx.state.doc.lineAt(pos);
    const lineNum = line.number - 1;            // 0-based
    const col = pos - line.from;                // 0-based
    const text = ctx.state.doc.toString();
    // >1MB skip guard（与 LspTracker 对齐：超大文件不走 LSP）
    if (text.length > 1_000_000) return null;
    try {
      // 先同步 doc 再请求补全：didChange 被 LspTracker 防抖 300ms，若不在此显式刷，
      // server 的 doc 落后于已输入字符——停顿后再按键（t 停顿再 a）会拿旧 doc 算
      // 补全（常为空），列表消失。await 保证 didChange 先于 completion 入 stdio 管道，
      // server 按序处理：先吃新 doc 再算补全，结果新鲜。
      await api.lspDidChange(workspaceRoot, filePath, lang, text);
      const items = await api.lspCompletion(workspaceRoot, filePath, lineNum + 1, col + 1);
      if (!items.length) return null;
      // from 锚到词首而非光标（词尾之后）：接受补全时替换已输入前缀，而非追加。
      // 输 a 接受 apiService → 替换 a 得 apiService（非 aapiService）；输 ap 时 CM
      // 用 from→光标 前缀过滤 = ap，apiService 命中。成员补全 apiService. 时
      // matchBefore(/\w*/) 为空匹配 → from=光标，在 . 后追加，正确。
      const from = ctx.matchBefore(/\w*/)?.from ?? ctx.pos;
      return {
        from,
        options: items.map((it) => {
          // documentation 可选：有值才挂 markdown 渲染闭包（空则不显示 info 面板）。
          // CM 类型里 CompletionInfo 只有 Node/{dom} 两种形态（运行时虽兼容 string），
          // 返回 { dom } 最贴近原语义：懒渲染、复用 hover 的 markdown 样式类。
          const doc = it.documentation;
          // 无文档但带 resolve 载荷：CM 选中条目时懒调 completionItem/resolve
          // （语言无关，支持 resolve 的 server 如 jdtls 常只给 data 不给文档）。
          // resolve 返回 detail+documentation 拼接渲染；失败/空 → null 不显示面板。
          const resolveInfo =
            !doc && it.resolve_item
              ? async () => {
                  try {
                    const r = await api.lspCompletionResolve(workspaceRoot, filePath, it.resolve_item);
                    const parts = [r.detail, r.documentation].filter(Boolean) as string[];
                    if (!parts.length) return null;
                    return { dom: makeHoverDom(parts.join("\n\n")) };
                  } catch {
                    return null;
                  }
                }
              : undefined;
          return {
            label: it.label,
            filterText: it.filter_text || undefined,
            apply: it.insert_text || it.label,
            detail: it.detail,
            info: doc ? () => ({ dom: makeHoverDom(doc) }) : resolveInfo,
            type: completionKind(it.kind),
          };
        }),
      };
    } catch (e) {
      // LSP 未就绪/请求失败：静默返回 null 让 CM 走无补全路径（输入不受影响）
      console.warn("[cmLsp] completion 失败:", e);
      return null;
    }
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

// linter 读 diagField（而非轮询 useLsp().diagnosticsFor）——diagField 由
// LspTracker 的 watch dispatch 进来，是 CM 状态里的单一真相源。needsRefresh
// 感知本地 setDiagnostics effect，让 @codemirror/lint 在 effect 事务后立即
// 重跑（默认 750ms 防抖），idle 也画波浪线（spec §7 flow 1）。
function lspLinter(workspaceRoot: string, filePath: string) {
  return linter(
    (view) => {
      if (!workspaceRoot) return [];
      const diags: LspDiagnostic[] = view.state.field(diagField, false) ?? [];
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
    },
    { needsRefresh: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setDiagnostics))) },
  );
}

// hover 请求去重 + 内容缓存。lspHover source 返回 promise，CM6 HoverPlugin 把它置
// pending，并在每次 editor update 后重触——jdtls 索引期 publishDiagnostics 频繁到达，
// 每次触发 setDiagnostics dispatch → HoverPlugin update → 重发 lspHover，数十请求堆积
// 在 jdtls 串行 stdio 管道，单个被拖到 80-100s（diag 实测）。in-flight 去重：同 position
// pending 期间复用同一 promise 不重发；返回后缓存 content，后续 update 重触走 cache 同步
// 返（不 pending、不重发）。key 含 doc.length：doc 编辑后 length 变 → key 变 → 不命中陈旧。
const hoverInflight = new Map<string, Promise<Tooltip | null>>();
const hoverCache = new Map<string, string>();
const HOVER_CACHE_CAP = 50;

function makeHoverDom(content: string): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "aide-lsp-hover";
  dom.innerHTML = renderMarkdown(content);
  return dom;
}

function lspHover(workspaceRoot: string, filePath: string) {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    if (!workspaceRoot) { console.warn(`[hover] lsp skip no-ws pos=${pos}`); return null; }
    const line = view.state.doc.lineAt(pos);
    const lineNum = line.number - 1;
    const col = pos - line.from;
    const key = `${filePath}|${view.state.doc.length}|${lineNum + 1}|${col + 1}`;
    // 缓存命中：同步返（非 promise）→ CM6 不置 pending → 不因 update 重触重发
    const cached = hoverCache.get(key);
    if (cached !== undefined) {
      console.warn(`[hover] lsp cached len=${cached.length}`);
      return { pos, above: true, create() { return { dom: makeHoverDom(cached) }; } };
    }
    // in-flight 去重：同 position pending 期间复用同一 promise，diagnostics update 重触时不重发
    const existing = hoverInflight.get(key);
    if (existing) { console.warn(`[hover] lsp inflight-reuse`); return existing; }
    const tHover = performance.now();
    console.warn(`[hover] lsp source line=${lineNum + 1} col=${col + 1} pos=${pos} file=${filePath}`);
    const p = (async (): Promise<Tooltip | null> => {
      try {
        const { content } = await api.lspHover(workspaceRoot, filePath, lineNum + 1, col + 1);
        console.warn(`[hover] lsp result ms=${(performance.now() - tHover).toFixed(0)} len=${content?.length || 0}`);
        if (!content) return null;
        if (hoverCache.size >= HOVER_CACHE_CAP) {
          const oldest = hoverCache.keys().next().value;
          if (oldest !== undefined) hoverCache.delete(oldest);
        }
        hoverCache.set(key, content);
        return { pos, above: true, create() { return { dom: makeHoverDom(content) }; } };
      } catch (e) { console.warn(`[hover] lsp err ${e}`); return null; }
    })();
    hoverInflight.set(key, p);
    p.finally(() => hoverInflight.delete(key));
    return p;
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
    cmSignatureHelp({ workspaceRoot: opts.workspaceRoot, filePath: opts.filePath, lang: opts.lang }),
    EditorView.baseTheme({
      ".aide-lsp-hover": {
        maxWidth: "480px", padding: "6px 10px",
        fontSize: "12.5px", lineHeight: "1.5",
      },
      ".aide-lsp-hover pre": { margin: "4px 0", padding: "6px", overflow: "auto" },
    }),
  ];
}
