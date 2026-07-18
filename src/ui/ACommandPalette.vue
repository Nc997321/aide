<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";
import IconOrChar from "../components/IconOrChar.vue";
import Icon from "../components/Icon.vue";

export interface PaletteResult {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  group: string;
  action: () => void;
}

export interface PaletteProvider {
  id: string;
  label: string;
  priority: number;
  search(query: string, limit: number): Promise<PaletteResult[]>;
}

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const query = ref("");
const results = ref<PaletteResult[]>([]);
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
let searchFn: ((q: string, limit: number) => Promise<PaletteResult[]>) | null = null;

function setSearchFn(fn: (q: string, limit: number) => Promise<PaletteResult[]>) {
  searchFn = fn;
}

let recentFn: (() => Promise<PaletteResult[]>) | null = null;

function setRecentFn(fn: () => Promise<PaletteResult[]>) {
  recentFn = fn;
}

const grouped = computed(() => {
  const groups: Record<string, PaletteResult[]> = {};
  for (const r of results.value) {
    if (!groups[r.group]) groups[r.group] = [];
    groups[r.group].push(r);
  }
  return groups;
});

const emptyHint = computed(() =>
  query.value.trim() ? "无匹配结果" : "暂无最近访问",
);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(query, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!q.trim()) {
    // 空查询：展示最近访问
    if (recentFn) {
      recentFn()
        .then((r) => {
          results.value = r;
          selectedIndex.value = 0;
        })
        .catch(() => {
          results.value = [];
          selectedIndex.value = 0;
        });
    } else {
      results.value = [];
      selectedIndex.value = 0;
    }
    return;
  }
  debounceTimer = setTimeout(async () => {
    if (!searchFn) return;
    results.value = await searchFn(q.trim(), 8);
    selectedIndex.value = 0;
  }, 150);
});

watch(
  () => props.open,
  async (v) => {
    if (v) {
      query.value = "";
      results.value = [];
      selectedIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
      if (recentFn) {
        try {
          results.value = await recentFn();
          selectedIndex.value = 0;
        } catch {
          results.value = [];
        }
      }
    }
  },
);

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
    return;
  }
  if (results.value.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, results.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = results.value[selectedIndex.value];
    if (item) {
      item.action();
      emit("close");
    }
  }
}

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    emit("close");
  }
}

defineExpose({ setSearchFn, setRecentFn });
</script>

<template>
  <Teleport to="body">
    <Transition name="a-palette">
      <div v-if="open" class="a-palette-overlay" @click="onOverlayClick">
        <div class="a-palette-box">
          <div class="a-palette-input-row">
            <span class="a-palette-icon"><Icon name="search" :size="15" /></span>
            <input
              ref="inputRef"
              v-model="query"
              class="a-palette-input"
              placeholder="搜索会话、文件或命令..."
              @keydown="onKeydown"
            />
          </div>
          <div v-if="results.length > 0" class="a-palette-results">
            <template v-for="(items, group) in grouped" :key="group">
              <div class="a-palette-section">{{ group }}</div>
              <div
                v-for="item in items"
                :key="item.id"
                class="a-palette-item"
                :class="{ 'a-palette-item--selected': results.indexOf(item) === selectedIndex }"
                @click="item.action(); emit('close')"
                @mouseenter="selectedIndex = results.indexOf(item)"
              >
                <span class="a-palette-item-icon"><IconOrChar :text="item.icon || 'file'" :size="14" /></span>
                <div class="a-palette-item-text">
                  <div class="a-palette-item-label">{{ item.label }}</div>
                  <div v-if="item.description" class="a-palette-item-desc">{{ item.description }}</div>
                </div>
              </div>
            </template>
          </div>
          <div v-else class="a-palette-empty">{{ emptyHint }}</div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
.a-palette-overlay {
  position: fixed;
  inset: 0;
  background: var(--aide-bg-overlay);
  display: flex;
  justify-content: center;
  padding-top: 80px;
  z-index: 10000;
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

.a-palette-box {
  width: 100%;
  max-width: 480px;
  max-height: 400px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.a-palette-input-row {
  display: flex;
  align-items: center;
  padding: 13px 16px;
  gap: 10px;
  border-bottom: 1px solid var(--aide-border-subtle);
  font-size: 14px;
  color: var(--aide-text-muted);
}

.a-palette-icon {
  display: inline-flex;
  align-items: center;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

.a-palette-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--aide-text-primary);
  font-size: 14px;
  font-family: inherit;
}

.a-palette-input::placeholder {
  color: var(--aide-text-muted);
}

.a-palette-results {
  overflow-y: auto;
  padding: 6px;
}

.a-palette-empty {
  padding: 18px;
  text-align: center;
  color: var(--aide-text-muted);
  font-size: 12px;
}

.a-palette-section {
  padding: 8px 8px 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--aide-text-muted);
}

.a-palette-item {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 6px;
  padding: 8px 10px;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--aide-text-secondary);
  transition: all var(--aide-ease-t);
}

.a-palette-item:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.a-palette-item--selected {
  background: var(--aide-accent-subtle);
  color: var(--aide-text-primary);
  box-shadow: inset 2px 0 0 var(--aide-accent);
}

.a-palette-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  width: 20px;
  flex-shrink: 0;
  color: var(--aide-accent);
}

.a-palette-item-text {
  min-width: 0;
  flex: 1;
}

.a-palette-item-label {
  font-size: 13px;
  color: var(--aide-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.a-palette-item-desc {
  font-size: 11px;
  color: var(--aide-text-muted);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.a-palette-item-kbd {
  margin-left: auto;
  font-size: 10.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  color: var(--aide-text-muted);
  font-family: var(--aide-font-mono);
  box-shadow: 0 1px 0 var(--aide-border);
}

/* Transitions */
.a-palette-enter-active {
  transition: opacity 0.12s ease-out;
}

.a-palette-enter-active .a-palette-box {
  transition: transform var(--aide-ease-t), opacity var(--aide-ease-t);
}

.a-palette-leave-active {
  transition: opacity 0.1s ease;
}

.a-palette-leave-active .a-palette-box {
  transition: transform 0.1s ease, opacity 0.1s ease;
}

.a-palette-enter-from {
  opacity: 0;
}

.a-palette-enter-from .a-palette-box {
  opacity: 0;
  transform: scale(0.96);
}

.a-palette-leave-to {
  opacity: 0;
}

.a-palette-leave-to .a-palette-box {
  opacity: 0;
  transform: scale(0.96);
}
</style>
