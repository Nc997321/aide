import { ref, readonly } from "vue";
import { api } from "../api";
import { useLsp } from "./useLsp";
import type { GrepMatch, QueryResult } from "../types";

/** 路径归一为「正斜杠、相对 projectRoot」形式，供跨 provider 自引用过滤比较。
 *  LSP Location→QueryResult.file 是绝对路径（uri_to_path 出来），codegraph/grep
 *  是相对路径，source.sourceFile 也是相对路径——三者形态不一，统一归一后再比，
 *  避免 LSP 多结果时点击点自身因「绝对 ≠ 相对」而滤不掉、混进浮层。 */
function normFile(root: string, p: string): string {
  const r = root.replace(/\\/g, "/");
  const x = p.replace(/\\/g, "/");
  if (r && x.startsWith(r + "/")) return x.slice(r.length + 1);
  return x;
}

// Module-level singleton
const visible = ref(false);
const results = ref<QueryResult[]>([]);
const selectedIndex = ref(0);
const searchWord = ref("");

const targetProjectRoot = ref("");
const isGrepFallback = ref(false);
/** 当前浮层模式：search()=定义，searchAllReferences()=引用。决定标题文案。 */
const mode = ref<"definition" | "references">("definition");

let lastProjectRoot = "";
let lastSourceExt = "";

export function useGotoDefinition() {
  async function search(
    word: string,
    projectRoot: string,
    source?: { sourceFile: string; sourceFileAbs?: string; sourceLine: number; sourceExt: string; sourceColumn?: number },
  ) {
    if (!word || !projectRoot) return;

    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    lastProjectRoot = projectRoot;
    lastSourceExt = source?.sourceExt || "";
    results.value = [];
    selectedIndex.value = 0;
    visible.value = true;
    isGrepFallback.value = false;
    mode.value = "definition";

    // 0. Try LSP first (workspace LSP on + server available → authoritative)
    try {
      if (source?.sourceFileAbs && useLsp().isLspOn(projectRoot)) {
        // LSP 要绝对路径（与 didOpen 的 URI 对齐才能命中文档），用 sourceFileAbs；
        // 自引用过滤也用绝对路径经 normFile 归一比较（LSP 结果 file 是绝对）。
        const srcAbs = source.sourceFileAbs;
        const srcLine = source.sourceLine;
        const lspResults = await api.lspDefinition(
          projectRoot,
          srcAbs,
          srcLine,
          source?.sourceColumn ?? 0,
          word,
        );
        if (lspResults.length > 0) {
          const filtered = lspResults.filter(
            r => !(normFile(projectRoot, r.symbol.file) === normFile(projectRoot, srcAbs) && r.symbol.line === srcLine),
          );
          if (filtered.length > 0) {
            results.value = filtered;
            isGrepFallback.value = false;
            return;
          }
        }
      }
    } catch {
      // LSP unavailable / error → fall through to codegraph → grep
    }

    // 1. Try CodeGraph first
    try {
      const cgResults = await api.codegraphGotoDefinition(
        word,
        source?.sourceFile || "",
        source?.sourceLine || 0,
        source?.sourceColumn ?? 0,
        projectRoot,
      );

      if (cgResults.length > 0) {
        // Filter out self-reference (same file, same line)
        let filtered = cgResults;
        if (source?.sourceFile) {
          filtered = cgResults.filter(
            r => !(normFile(projectRoot, r.symbol.file) === normFile(projectRoot, source.sourceFile) && r.symbol.line === source.sourceLine),
          );
        }
        results.value = filtered;
        return;
      }
    } catch {
      // CodeGraph unavailable — fall through to grep
    }

    // 2. Fallback: grep-level search (existing behavior)
    isGrepFallback.value = true;
    try {
      let matches: GrepMatch[] = await api.grepSymbol(word, projectRoot, source?.sourceExt);
      if (source?.sourceFile) {
        matches = matches.filter(
          m => !(normFile(projectRoot, m.file) === normFile(projectRoot, source.sourceFile) && m.line === source.sourceLine),
        );
      }
      // Convert GrepMatch[] to QueryResult[] for unified rendering.
      // grep 是 word-boundary 精确文本匹配，既非 tree-sitter 结构层也非向量语义层；
      // 这里 confidence/score 仅是为满足 QueryResult 类型的占位，渲染层走
      // isGrepFallback 标志显示 [匹配] 标签，不读这俩字段——勿据此判断"是定义"。
      results.value = matches.slice(0, 20).map(m => ({
        symbol: {
          name: word,
          kind: "Variable" as const,
          file: m.file,
          line: m.line,
          column: 0,
          parent: null,
        },
        confidence: "Semantic" as const,
        score: null,
      }));
    } catch {
      results.value = [];
    }
  }

  function dismiss() {
    visible.value = false;
    results.value = [];
    selectedIndex.value = 0;
  }

  function selectPrev() {
    if (results.value.length === 0) return;
    selectedIndex.value =
      (selectedIndex.value - 1 + results.value.length) % results.value.length;
  }

  function selectNext() {
    if (results.value.length === 0) return;
    selectedIndex.value = (selectedIndex.value + 1) % results.value.length;
  }

  function getSelected(): QueryResult | null {
    if (results.value.length === 0) return null;
    return results.value[selectedIndex.value] ?? null;
  }

  async function searchAllReferences(word: string, projectRoot: string) {
    if (!word || !projectRoot) return;

    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    results.value = [];
    selectedIndex.value = 0;
    visible.value = true;
    isGrepFallback.value = false;
    mode.value = "references";

    // Try CodeGraph with broader scope (no current-file filter)
    try {
      const cgResults = await api.codegraphGotoDefinition(
        word, "", 0, 0, projectRoot,
      );
      if (cgResults.length > 0) {
        results.value = cgResults;
        return;
      }
    } catch { /* fall through */ }

    // Fallback to grep
    isGrepFallback.value = true;
    try {
      const matches = await api.grepSymbol(word, projectRoot, lastSourceExt || undefined);
      // 同 search() 的 grep 兜底：confidence/score 是类型占位，渲染走 isGrepFallback。
      results.value = matches.map(m => ({
        symbol: {
          name: word,
          kind: "Variable" as const,
          file: m.file,
          line: m.line,
          column: 0,
          parent: null,
        },
        confidence: "Semantic" as const,
        score: null,
      }));
    } catch {
      results.value = [];
    }
  }

  return {
    visible: readonly(visible),
    results: readonly(results),
    selectedIndex: readonly(selectedIndex),
    searchWord: readonly(searchWord),
    isGrepFallback: readonly(isGrepFallback),
    mode: readonly(mode),
    search,
    searchAllReferences,
    dismiss,
    selectPrev,
    selectNext,
    getSelected,
    getProjectRoot: () => lastProjectRoot,
  };
}
