<script setup lang="ts">
import { ref, watch, nextTick, computed, onUnmounted } from "vue";
import IconOrChar from "../components/IconOrChar.vue";
import Icon from "../components/Icon.vue";
import { vOverlayLayer } from "../directives/overlayLayer";

export interface PaletteResult {
  id: string;
  label: string;
  description?: string;
  /** Full context shown through the theme-aware v-tooltip directive. */
  tooltip?: string;
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
  /** 输入框拿到焦点 / 被点击：请求父级把 open 置 true（Ctrl+P 也是父级置 open，两条入口汇到同一个状态）。 */
  open: [];
  close: [];
}>();

const query = ref("");
const results = ref<PaletteResult[]>([]);
const selectedIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
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

onUnmounted(() => {
  // 组件销毁后防抖回调仍会触发 searchFn 并写 results——卸载即清，避免泄漏
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
});

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
    if (!v) {
      // 关闭 = 收起面板 + 失焦（面板点击靠 mousedown.prevent 保焦点，不主动失焦的话
      // 选完一项后输入框仍占着焦点，再点它就不会触发 focus、面板打不开）
      query.value = "";
      inputRef.value?.blur();
      return;
    }
    query.value = "";
    results.value = [];
    selectedIndex.value = 0;
    await nextTick();
    // Ctrl+P 进来时焦点还不在输入框；点击进来时已经在，focus() 是空操作
    if (document.activeElement !== inputRef.value) inputRef.value?.focus();
    if (recentFn) {
      try {
        results.value = await recentFn();
        selectedIndex.value = 0;
      } catch {
        results.value = [];
      }
    }
  },
);

// 方向键移动高亮时让它留在可视区内（最近会话 + 最近文件 + 搜索结果可能超过面板高度）
watch(selectedIndex, async () => {
  await nextTick();
  panelRef.value?.querySelector(".a-palette-item--selected")?.scrollIntoView?.({ block: "nearest" });
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
    return;
  }
  if (e.isComposing) return; // 中文选词的 Enter/方向键不是在操作面板
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

/** 点击 / Tab 进输入框都算"开始搜索"。 */
function requestOpen() {
  if (!props.open) emit("open");
}

/** 失焦 = 收起（点面板外、Tab 走开、切窗口）。面板内点击靠 mousedown.prevent 不会走到这。 */
function onBlur() {
  if (props.open) emit("close");
}

defineExpose({ setSearchFn, setRecentFn });
</script>

<template>
  <!-- 标题栏里的搜索框（VS Code 式）：点击原地输入，结果挂在输入框正下方，不再弹居中模态。
       输入框常驻（不是 v-if）；只有下拉面板随 open 出现。 -->
  <div class="a-search">
    <div class="a-search-field" :class="{ 'a-search-field--open': open }">
      <span class="a-palette-icon"><Icon name="search" :size="13" /></span>
      <input
        ref="inputRef"
        v-model="query"
        class="a-palette-input"
        placeholder="搜索会话、文件或命令..."
        @focus="requestOpen"
        @click="requestOpen"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <kbd v-if="!open" class="a-search-kbd">Ctrl+P</kbd>
    </div>
    <!-- 面板盖在主区之上：登记到浮层登记处，让内嵌浏览器的原生视图让位（否则被网页吃掉下半截）。
         mousedown.prevent：点面板（含滚动条）不抢输入框焦点，否则 blur 先于 click 把面板收了 -->
    <Transition name="a-palette">
      <div v-if="open" ref="panelRef" class="a-palette-box" v-overlay-layer @mousedown.prevent>
        <div v-if="results.length > 0" class="a-palette-results">
          <template v-for="(items, group) in grouped" :key="group">
            <div class="a-palette-section">{{ group }}</div>
            <div
              v-for="item in items"
              :key="item.id"
              v-tooltip="item.tooltip"
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
    </Transition>
  </div>
</template>

<style>
/* 标题栏居中的搜索框：占位与尺寸沿用原触发按钮（flex:1 / 最宽 360 / 居中） */
.a-search {
  position: relative;
  flex: 1;
  max-width: 360px;
  margin: 0 auto;
}

.a-search-field {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--aide-surface-default);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-md);
  padding: 5px 12px;
  color: var(--aide-text-muted);
  font-size: 12px;
  cursor: text;
  box-shadow: var(--aide-highlight-inset);
  transition: all var(--aide-ease-t);
}
.a-search-field:hover {
  background: var(--aide-surface-hover);
}
.a-search-field--open {
  background: var(--aide-bg-raised);
  border-color: var(--aide-accent);
  box-shadow: var(--aide-accent-ring);
}

.a-search-kbd {
  margin-left: auto;
  background: var(--aide-bg-deep);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  color: var(--aide-text-muted);
  border: 1px solid var(--aide-border);
  font-family: inherit;
}

/* 下拉面板：挂在输入框正下方、水平居中，比输入框宽（结果行要放得下路径） */
.a-palette-box {
  position: absolute;
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  width: 520px;
  max-width: calc(100vw - 32px);
  max-height: min(420px, 70vh);
  z-index: 10000;
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

.a-palette-icon {
  display: inline-flex;
  align-items: center;
  color: var(--aide-text-muted);
  flex-shrink: 0;
}

.a-palette-input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  color: var(--aide-text-primary);
  font-size: 12px;
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

/* Transitions：面板自身淡入 + 轻微下移（translateX 居中要一并写进 transform） */
.a-palette-enter-active,
.a-palette-leave-active {
  transition: opacity var(--aide-ease-t), transform var(--aide-ease-t);
}
.a-palette-enter-from,
.a-palette-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-4px);
}
</style>
