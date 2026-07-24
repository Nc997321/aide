import { computed, reactive, ref } from "vue";
import type { Terminal } from "xterm";
import { SearchAddon, type ISearchDecorationOptions } from "xterm-addon-search";
import { cssVar } from "../utils/xterm";
import { activeId as coreActiveId } from "./workbenchTerminalState";

/**
 * 终端面板搜索的状态层：每个终端会话注册一个 SearchAddon（含匹配高亮 decorations
 * 与结果计数事件），搜索条 UI（components/workbenchterminal/SearchBar.vue）只读写
 * 这里暴露的响应式状态。decorations 颜色在每次 find 时现读 --aide-* token，
 * 主题切换后经 refreshTheme() 原地重绘（incremental 复用当前选区，不跳动）。
 */

// 物理对象（非响应式）
const addons = new Map<string, SearchAddon>();
const terminals = new Map<string, Terminal>();

// UI 状态（响应式）
const visible = ref(false);
const query = ref("");
const caseSensitive = ref(false);
// sessionId -> { index: 当前匹配序号(0 起, 超上限为 -1), count: 总匹配数 }
const results = reactive(new Map<string, { index: number; count: number }>());

/** 供 useWorkbenchTerminal 在建会话（shell / run）时调用；同 id 重复调用是 no-op。 */
export function registerSearch(id: string, terminal: Terminal) {
  if (addons.has(id)) return;
  const addon = new SearchAddon();
  terminal.loadAddon(addon);
  addon.onDidChangeResults((r) => {
    results.set(id, { index: r.resultIndex, count: r.resultCount });
  });
  addons.set(id, addon);
  terminals.set(id, terminal);
}

/** 会话销毁时调用（addon 本体随 terminal.dispose() 释放，这里只清注册表）。 */
export function unregisterSearch(id: string) {
  addons.delete(id);
  terminals.delete(id);
  results.delete(id);
}

/** 把任意 CSS 颜色表达式（含 color-mix）解析成 #RRGGBB：
 *  WebView2/Chromium 的 getComputedStyle 会把 color-mix 算成 rgb()。
 *  用于让 xterm canvas 高亮与 CodeMirror 搜索高亮（warning 25%/45%）严格同色。 */
let colorProbe: HTMLSpanElement | null = null;
function resolveToHex(expr: string, fallback: string): string {
  try {
    if (!colorProbe) {
      colorProbe = document.createElement("span");
      colorProbe.style.display = "none";
      document.body.appendChild(colorProbe);
    }
    colorProbe.style.color = "";
    colorProbe.style.color = expr;
    const rgb = getComputedStyle(colorProbe).color;
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
    if (!m) return fallback;
    const h = (n: string) => Number(n).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  } catch {
    return fallback;
  }
}

function searchDecorations(): ISearchDecorationOptions {
  // 兜底中性灰：仅在 token 缺失/解析失败时才会用到（:root 恒有兜底，正常不触发）
  const neutral = "#808080";
  return {
    // 与 CodeEditor.vue 的 .cm-searchMatch / .cm-searchMatch-selected 同配方
    matchBackground: resolveToHex("color-mix(in srgb, var(--aide-warning) 25%, var(--aide-bg-deep))", neutral),
    matchOverviewRuler: resolveToHex(cssVar("warning"), neutral),
    activeMatchBackground: resolveToHex("color-mix(in srgb, var(--aide-warning) 45%, var(--aide-bg-deep))", neutral),
    activeMatchColorOverviewRuler: resolveToHex(cssVar("accent"), neutral),
  };
}

export function useTerminalSearch() {
  function activeAddon(): SearchAddon | undefined {
    const id = coreActiveId.value;
    return id ? addons.get(id) : undefined;
  }

  function open() {
    // 打开时用终端当前选区做初始查询词（单行才取）；已打开时不重置用户输入。
    if (!visible.value) {
      const id = coreActiveId.value;
      const t = id ? terminals.get(id) : undefined;
      const sel = t?.getSelection() ?? "";
      if (sel && !sel.includes("\n")) query.value = sel;
    }
    visible.value = true;
  }

  function close() {
    visible.value = false;
    activeAddon()?.clearDecorations();
    const id = coreActiveId.value;
    const t = id ? terminals.get(id) : undefined;
    t?.focus();
  }

  /** incremental=true：输入逐字变化时沿用当前选区扩匹配（不跳到下一处）。 */
  function findNext(incremental = false) {
    const addon = activeAddon();
    if (!addon) return;
    if (!query.value) {
      addon.clearDecorations();
      return;
    }
    addon.findNext(query.value, {
      caseSensitive: caseSensitive.value,
      incremental,
      decorations: searchDecorations(),
    });
  }

  function findPrev() {
    const addon = activeAddon();
    if (!addon || !query.value) return;
    addon.findPrevious(query.value, {
      caseSensitive: caseSensitive.value,
      decorations: searchDecorations(),
    });
  }

  /** 主题切换后重绘高亮：incremental 复用当前选区重放，匹配位置不跳动。 */
  function refreshTheme() {
    if (visible.value && query.value) findNext(true);
  }

  const activeResults = computed(() => {
    const id = coreActiveId.value;
    return id ? results.get(id) ?? null : null;
  });

  return {
    visible,
    query,
    caseSensitive,
    activeResults,
    open,
    close,
    findNext,
    findPrev,
    refreshTheme,
  };
}
