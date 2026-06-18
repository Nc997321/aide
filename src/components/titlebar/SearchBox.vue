<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useSearchProviders, type SearchResult } from "../../composables/useSearchProviders";

const query = ref("");
const results = ref<SearchResult[]>([]);
const selectedIndex = ref(0);
const visible = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
const { search } = useSearchProviders();

const groupedResults = computed(() => {
  const groups: Record<string, SearchResult[]> = {};
  for (const r of results.value) {
    // Provider label comes from the result set — we store a providerId on each result
    // Actually we don't have providerId on SearchResult. Let's use a simpler grouping:
    // Group by icon prefix: 📝 = sessions, 📄 = files
    const group = r.icon === "📝" ? "会话" : r.icon === "📄" ? "文件" : "其他";
    if (!groups[group]) groups[group] = [];
    groups[group].push(r);
  }
  return groups;
});

const hasResults = computed(() => results.value.length > 0);

async function doSearch() {
  if (!query.value.trim()) {
    results.value = [];
    selectedIndex.value = 0;
    return;
  }
  results.value = await search(query.value.trim(), 6);
  selectedIndex.value = 0;
}

// Debounced search on query change
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(query, () => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    doSearch();
  }, 80);
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return;
  }
  if (!hasResults.value) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, results.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const selected = results.value[selectedIndex.value];
    if (selected) {
      selected.action();
      close();
    }
  }
}

function open() {
  visible.value = true;
  query.value = "";
  results.value = [];
  selectedIndex.value = 0;
  nextTick(() => {
    inputRef.value?.focus();
  });
}

function close() {
  visible.value = false;
  query.value = "";
  results.value = [];
  selectedIndex.value = 0;
  inputRef.value?.blur();
}

function onClickOutside(e: MouseEvent) {
  // Only close if clicking outside the search dropdown and not on the search input
  const target = e.target as HTMLElement;
  if (!target.closest(".searchbox-wrapper") && !target.closest(".searchbox-dropdown")) {
    close();
  }
}

watch(visible, (v) => {
  if (v) {
    document.addEventListener("mousedown", onClickOutside);
  } else {
    document.removeEventListener("mousedown", onClickOutside);
  }
});

onUnmounted(() => {
  document.removeEventListener("mousedown", onClickOutside);
});

defineExpose({ open, close });
</script>

<template>
  <div class="searchbox-wrapper" @mousedown.stop>
    <div class="searchbox-input-row" :class="{ focused: visible }">
      <span class="searchbox-icon">🔍</span>
      <input
        ref="inputRef"
        v-model="query"
        class="searchbox-input"
        placeholder="搜索会话或文件..."
        @focus="visible = true"
        @keydown="onKeydown"
      />
      <span v-if="!visible" class="searchbox-hint">Ctrl+P</span>
    </div>

    <!-- Dropdown panel (Teleport to body so it overlays everything) -->
    <Teleport to="body">
      <Transition name="search-drop">
        <div
          v-if="visible && hasResults"
          class="searchbox-dropdown"
        >
          <template v-for="(items, group) in groupedResults" :key="group">
            <div class="search-result-group-label">{{ group }}</div>
            <div
              v-for="(item, idx) in items"
              :key="item.id"
              class="search-result-item"
              :class="{ selected: results.indexOf(item) === selectedIndex }"
              @click="item.action(); close()"
              @mouseenter="selectedIndex = results.indexOf(item)"
            >
              <span class="search-result-icon">{{ item.icon || "📄" }}</span>
              <div class="search-result-text">
                <div class="search-result-label">{{ item.label }}</div>
                <div v-if="item.description" class="search-result-desc">{{ item.description }}</div>
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.searchbox-wrapper {
  position: relative;
  flex: 0 1 420px;
  max-width: 480px;
  margin: 0 auto;
}

.searchbox-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border-radius: 6px;
  padding: 0 12px;
  height: 28px;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.searchbox-input-row.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(137, 180, 250, 0.2);
}

.searchbox-icon {
  font-size: 11px;
  flex-shrink: 0;
  opacity: 0.6;
}

.searchbox-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-size: 12.5px;
  font-family: inherit;
  line-height: 28px;
}

.searchbox-input::placeholder {
  color: var(--text-muted);
}

.searchbox-hint {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}
</style>

<!-- Non-scoped: dropdown lives in <body> via Teleport -->
<style>
.searchbox-dropdown {
  position: fixed;
  top: 38px;
  left: 50%;
  transform: translateX(-50%);
  width: 460px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--surface);
  border-top: none;
  border-radius: 0 0 8px 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 10000;
  padding: 6px 0;
}

.search-result-group-label {
  padding: 6px 14px 2px;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
}

.search-result-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  cursor: pointer;
  transition: background 0.08s;
}

.search-result-item:hover,
.search-result-item.selected {
  background: var(--surface);
}

.search-result-icon {
  font-size: 14px;
  flex-shrink: 0;
  width: 20px;
  text-align: center;
}

.search-result-text {
  min-width: 0;
}

.search-result-label {
  font-size: 12.5px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-result-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Dropdown transition */
.search-drop-enter-active {
  transition: opacity 0.1s ease, transform 0.1s ease;
}
.search-drop-leave-active {
  transition: opacity 0.08s ease, transform 0.08s ease;
}
.search-drop-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px);
}
.search-drop-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-4px);
}
</style>
