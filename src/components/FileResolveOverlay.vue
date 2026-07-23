<script setup lang="ts">
import { computed } from "vue";
import { useFileResolver } from "@/composables/useFileResolver";

const props = defineProps<{ workspacePath?: string }>();

const { resolving, resolvingName, candidates, pickerVisible, pickCandidate, cancelPicker } =
  useFileResolver();

/** 把候选绝对路径压成相对工作区的展示路径，读起来短且能区分同名文件。 */
function relDisplay(abs: string): string {
  const root = props.workspacePath;
  const norm = abs.replace(/\\/g, "/");
  if (root) {
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm.toLowerCase().startsWith(r.toLowerCase())) {
      return norm.slice(r.length).replace(/^\/+/, "");
    }
  }
  return norm;
}

const pickerTitle = computed(() => `找到 ${candidates.value.length} 个匹配文件，请选择`);
</script>

<template>
  <Teleport to="body">
    <!-- 搜索加载态：轻量浮条，不遮挡对话 -->
    <div v-if="resolving" class="fr-toast">
      <span class="fr-spinner" />
      <span class="fr-toast-text">正在查找 {{ resolvingName }}…</span>
    </div>

    <!-- 多命中选择：需要用户决策，用带背板的居中弹窗 -->
    <div v-if="pickerVisible" class="fr-overlay" @click.self="cancelPicker">
      <div class="fr-picker">
        <div class="fr-picker-head">{{ pickerTitle }}</div>
        <div class="fr-picker-list">
          <button
            v-for="path in candidates"
            :key="path"
            class="fr-picker-item"
            v-tooltip="path"
            @click="pickCandidate(path)"
          >
            <span class="fr-picker-rel">{{ relDisplay(path) }}</span>
          </button>
        </div>
        <div class="fr-picker-actions">
          <button class="fr-picker-cancel" @click="cancelPicker">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.fr-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9500;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  font-size: 12px;
  color: var(--aide-text-secondary);
}

.fr-spinner {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid var(--aide-surface-hover);
  border-top-color: var(--aide-accent);
  animation: fr-spin 0.7s linear infinite;
}

@keyframes fr-spin {
  to {
    transform: rotate(360deg);
  }
}

.fr-overlay {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--aide-bg-overlay);
  /* overlay dim — structural, not theme-governed blur */
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

.fr-picker {
  width: 480px;
  max-width: calc(100vw - 48px);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--aide-radius-md);
  background: var(--aide-bg-raised);
  border: 1px solid var(--aide-border-strong);
  box-shadow: var(--aide-shadow-lg), var(--aide-highlight-inset);
  backdrop-filter: var(--aide-surface-blur);
  -webkit-backdrop-filter: var(--aide-surface-blur);
  overflow: hidden;
}

.fr-picker-head {
  padding: 14px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aide-text-primary);
  border-bottom: 1px solid var(--aide-border);
}

.fr-picker-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.fr-picker-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: var(--aide-radius-sm);
  cursor: pointer;
  text-align: left;
  color: var(--aide-text-secondary);
  font-size: 12px;
  font-family: var(--aide-font-mono);
  transition: background 0.12s, color 0.12s;
}
.fr-picker-item:hover {
  background: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}

.fr-picker-rel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fr-picker-actions {
  display: flex;
  justify-content: flex-end;
  padding: 10px 16px;
  border-top: 1px solid var(--aide-border);
}

.fr-picker-cancel {
  border-radius: var(--aide-radius-sm);
  border: 1px solid var(--aide-border);
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}
.fr-picker-cancel:hover {
  background: var(--aide-surface-hover);
}
</style>
