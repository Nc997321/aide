import { ref, readonly } from "vue";
import { api } from "../api";
import type { GrepMatch } from "../types";

// Module-level singleton
const visible = ref(false);
const results = ref<GrepMatch[]>([]);
const selectedIndex = ref(0);
const searchWord = ref("");
const currentFilePath = ref("");
const targetProjectRoot = ref("");

// Cache: store last search context for jump-back / searchAllReferences
let lastProjectRoot = "";
let lastSourceExt = "";

export function useGotoDefinition() {
  async function search(word: string, projectRoot: string, source?: { sourceFile: string; sourceLine: number; sourceExt: string }) {
    if (!word || !projectRoot) return;

    searchWord.value = word;
    targetProjectRoot.value = projectRoot;
    lastProjectRoot = projectRoot;
    lastSourceExt = source?.sourceExt || "";
    results.value = [];
    selectedIndex.value = 0;
    visible.value = true;

    try {
      let matches = await api.grepSymbol(word, projectRoot, source?.sourceExt);
      if (source?.sourceFile) {
        matches = matches.filter(
          m => !(m.file === source.sourceFile && m.line === source.sourceLine)
        );
      }
      results.value = matches.slice(0, 20);
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
    selectedIndex.value =
      (selectedIndex.value + 1) % results.value.length;
  }

  function getSelected(): GrepMatch | null {
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

    try {
      const matches = await api.grepSymbol(word, projectRoot, lastSourceExt || undefined);
      results.value = matches;
    } catch {
      results.value = [];
    }
  }

  return {
    visible: readonly(visible),
    results: readonly(results),
    selectedIndex: readonly(selectedIndex),
    searchWord: readonly(searchWord),
    search,
    searchAllReferences,
    dismiss,
    selectPrev,
    selectNext,
    getSelected,
    getProjectRoot: () => lastProjectRoot,
  };
}
