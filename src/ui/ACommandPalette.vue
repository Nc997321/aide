<script setup lang="ts">
import { ref, watch, nextTick, computed } from "vue";

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

const grouped = computed(() => {
  const groups: Record<string, PaletteResult[]> = {};
  for (const r of results.value) {
    if (!groups[r.group]) groups[r.group] = [];
    groups[r.group].push(r);
  }
  return groups;
});

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(query, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (!q.trim()) {
    results.value = [];
    selectedIndex.value = 0;
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

defineExpose({ setSearchFn });
</script>

<template>
  <Teleport to="body">
    <Transition name="a-palette">
      <div v-if="open" class="a-palette-overlay" @click="onOverlayClick">
        <div class="a-palette-box">
          <div class="a-palette-input-row">
            <span class="a-palette-icon">&#x1F50D;</span>
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
                <span class="a-palette-item-icon">{{ item.icon || '&#x1F4C4;' }}</span>
                <div class="a-palette-item-text">
                  <div class="a-palette-item-label">{{ item.label }}</div>
                  <div v-if="item.description" class="a-palette-item-desc">{{ item.description }}</div>
                </div>
              </div>
            </template>
          </div>
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
  backdrop-filter: blur(8px);
}

.a-palette-box {
  width: 560px;
  max-height: 400px;
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.a-palette-input-row {
  display: flex;
  align-items: center;
  padding: 14px 18px;
  gap: 10px;
  border-bottom: 1px solid var(--aide-border);
}

.a-palette-icon {
  font-size: 16px;
  color: var(--aide-text-muted);
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

.a-palette-section {
  padding: 8px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--aide-text-muted);
}

.a-palette-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--aide-radius-md);
  cursor: pointer;
  transition: background 0.1s;
}

.a-palette-item:hover,
.a-palette-item--selected {
  background: var(--aide-surface-default);
}

.a-palette-item-icon {
  font-size: 14px;
  width: 20px;
  text-align: center;
  color: var(--aide-text-muted);
  flex-shrink: 0;
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

/* Transitions */
.a-palette-enter-active {
  transition: opacity 0.12s ease-out;
}
.a-palette-enter-active .a-palette-box {
  transition: transform 0.12s ease-out, opacity 0.12s ease-out;
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
