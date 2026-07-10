import { ref, readonly } from "vue";
import { api } from "../api";
import type { GrepMatch, QueryResult } from "../types";

// Module-level singleton
const visible = ref(false);
const results = ref<QueryResult[]>([]);
const selectedIndex = ref(0);
const searchWord = ref("");
const currentFilePath = ref("");
const targetProjectRoot = ref("");
const isGrepFallback = ref(false);

let lastProjectRoot = "";
let lastSourceExt = "";

export function useGotoDefinition() {
  async function search(
    word: string,
    projectRoot: string,
    source?: { sourceFile: string; sourceLine: number; sourceExt: string },
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

    // 1. Try CodeGraph first
    try {
      const cgResults = await api.codegraphGotoDefinition(
        word,
        source?.sourceFile || "",
        source?.sourceLine || 0,
        0, // column not yet from editor
        projectRoot,
      );

      if (cgResults.length > 0) {
        // Filter out self-reference (same file, same line)
        let filtered = cgResults;
        if (source?.sourceFile) {
          filtered = cgResults.filter(
            r => !(r.symbol.file === source.sourceFile && r.symbol.line === source.sourceLine),
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
          m => !(m.file === source.sourceFile && m.line === source.sourceLine),
        );
      }
      // Convert GrepMatch[] to QueryResult[] for unified rendering
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
    search,
    searchAllReferences,
    dismiss,
    selectPrev,
    selectNext,
    getSelected,
    getProjectRoot: () => lastProjectRoot,
  };
}
