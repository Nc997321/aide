<script setup lang="ts">
/**
 * 记忆观测台弹层壳：三 tab（记忆 / 演化 / 影响）+
 * 三路关闭（close / 点外部 / Esc）。数据闭包见 useMemoryObservatory。
 * spec：docs/superpowers/specs/2026-09-04-memory-observatory-design.md
 */
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import Icon from "@/components/Icon.vue";
import { useMemoryObservatory } from "@/composables/useMemoryObservatory";
import MemoryList from "./MemoryList.vue";
import EvolutionView from "./EvolutionView.vue";
import InfluenceView from "./InfluenceView.vue";

const props = defineProps<{ workspaceKey: string; workspaceName?: string; currentSessionId?: string | null }>();
const emit = defineEmits<{ close: [] }>();

const mo = useMemoryObservatory();
const tab = ref<"memory" | "evolution" | "influence">("memory");

onMounted(() => {
  mo.load(props.workspaceKey);
  window.addEventListener("keydown", onKey, true);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, true));
watch(
  () => props.workspaceKey,
  (k) => k && mo.load(k),
);

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="mo-overlay" @click.self="emit('close')">
      <div class="mo-panel" role="dialog" aria-modal="true">
        <header class="mo-head">
          <span class="mo-logo"><Icon name="cube" :size="14" /></span>
          <h1>记忆观测台</h1>
          <span v-if="workspaceName" class="mo-ws">{{ workspaceName }}</span>
          <span class="mo-spacer" />
          <button class="mo-close" v-tooltip="'关闭'" @click="emit('close')">
            <Icon name="close" :size="13" :stroke-width="1.4" />
          </button>
        </header>

        <nav class="mo-tabs">
          <button class="mo-tab" :class="{ on: tab === 'memory' }" @click="tab = 'memory'">
            记忆<span v-if="mo.scan.value" class="n">{{ mo.scan.value.topics.length }}</span>
          </button>
          <button class="mo-tab" :class="{ on: tab === 'evolution' }" @click="tab = 'evolution'">演化</button>
          <button class="mo-tab" :class="{ on: tab === 'influence' }" @click="tab = 'influence'">影响</button>
        </nav>

        <div class="mo-body">
          <div v-if="mo.loading.value && !mo.scan.value" class="mo-state">读取记忆中…</div>
          <div v-else-if="mo.error.value" class="mo-state err">{{ mo.error.value }}</div>
          <div v-else-if="!mo.scan.value" class="mo-state">尚无数据</div>
          <template v-else>
            <MemoryList
              v-show="tab === 'memory'"
              :scan="mo.scan.value"
              :previews="mo.previews"
              :confirming="mo.confirming.value"
              :deleting="mo.deleting.value"
              :events="mo.events.value"
              @preview="(n) => mo.preview(props.workspaceKey, n)"
              @confirm="(n) => (mo.confirming.value = n)"
              @delete="(n) => mo.remove(props.workspaceKey, n)"
            />
            <EvolutionView v-show="tab === 'evolution'" :scan="mo.scan.value" :diff="mo.diff.value" />
            <InfluenceView
              v-show="tab === 'influence'"
              :scan="mo.scan.value"
              :events="mo.events.value"
              :session-names="mo.sessionNames.value"
              :current-session-id="props.currentSessionId"
            />
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mo-overlay {
  position: fixed;
  inset: 0;
  background: var(--aide-bg-overlay);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.mo-panel {
  width: 880px;
  max-width: 92vw;
  height: 85vh;
  max-height: 780px;
  background: var(--aide-bg-base);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-lg);
  box-shadow: var(--aide-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.mo-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px 0;
}
.mo-logo { color: var(--aide-accent); display: inline-flex; }
.mo-head h1 { font-size: 14px; font-weight: 600; color: var(--aide-text-primary); }
.mo-ws { font-size: 11px; color: var(--aide-text-muted); font-family: ui-monospace, Consolas, monospace; }
.mo-spacer { flex: 1; }
.mo-close {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--aide-radius-sm);
  background: transparent;
  color: var(--aide-text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.mo-close:hover { background: var(--aide-surface-hover); color: var(--aide-text-primary); }

.mo-tabs {
  display: flex;
  gap: 24px;
  padding: 12px 20px 0;
  border-bottom: 1px solid var(--aide-border-subtle);
}
.mo-tab {
  padding: 4px 2px 10px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--aide-text-secondary);
  font-size: 13px;
  position: relative;
}
.mo-tab:hover { color: var(--aide-text-primary); }
.mo-tab.on { color: var(--aide-text-primary); font-weight: 600; }
.mo-tab.on::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--aide-accent);
  border-radius: 1px;
}
.mo-tab .n { color: var(--aide-text-muted); font-weight: 400; margin-left: 5px; font-size: 11px; }

.mo-body { flex: 1; overflow-y: auto; padding: 20px 20px 24px; }
.mo-state { color: var(--aide-text-muted); font-size: 12.5px; padding: 40px 0; text-align: center; }
.mo-state.err { color: var(--aide-danger); }
</style>
