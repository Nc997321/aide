<script setup lang="ts">
/**
 * 记忆观测台弹层壳：三 tab（记忆 / 演化 / 影响）+ 双 scope（当前项目 / 全部项目，
 * P2 跨项目只读聚合）+ 三路关闭（close / 点外部 / Esc）。数据闭包见 useMemoryObservatory。
 * spec：docs/superpowers/specs/2026-09-04-memory-observatory-design.md
 */
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import Icon from "@/components/Icon.vue";
import { useMemoryObservatory } from "@/composables/useMemoryObservatory";
import { useWorkspaces } from "@/composables/useWorkspaces";
import type { MemoryScanResult } from "@aide/sdk/api";
import { sumReachLevels } from "./observatory";
import MemoryList from "./MemoryList.vue";
import GlobalMemoryList from "./GlobalMemoryList.vue";
import EvolutionView from "./EvolutionView.vue";
import InfluenceView from "./InfluenceView.vue";

const props = defineProps<{ workspaceKey: string; workspaceName?: string; currentSessionId?: string | null }>();
const emit = defineEmits<{ close: [] }>();

const mo = useMemoryObservatory();
const tab = ref<"memory" | "evolution" | "influence">("memory");

// workspaceKey → 显示名（登记过的工作区用其名，未登记回落 key 本身）
const { workspaces } = useWorkspaces();
const projectNames = computed<Record<string, string>>(() =>
  Object.fromEntries(workspaces.value.map((w) => [w.key, w.name])),
);

// 演化/影响 tab 在全局模式吃合成 scan：topics 全量合并（曲线只读时间戳，重名无碍）；
// 可达性分级各项目窗口独立，用 sumReachLevels 汇总后走 reachOverride。
const mergedScan = computed<MemoryScanResult | null>(() => {
  if (mo.scope.value !== "all") return mo.scan.value;
  if (mo.projectScans.value.length === 0 && mo.loading.value) return null; // 加载中不闪空态
  const first = mo.projectScans.value[0]?.scan;
  return {
    index: null,
    topics: mo.projectScans.value.flatMap((p) => p.scan.topics),
    orphans: [],
    deadlinks: [],
    claudeMd: mo.globalClaudeMd.value,
    limits: first?.limits ?? { maxLines: 200, maxBytes: 25 * 1024 },
  };
});
const globalReach = computed(() =>
  mo.scope.value === "all"
    ? sumReachLevels(mo.projectScans.value.map((p) => p.scan), mo.globalClaudeMd.value != null)
    : null,
);

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
          <div class="mo-scope">
            <button :class="{ on: mo.scope.value === 'project' }" @click="mo.setScope('project', props.workspaceKey)">
              当前项目
            </button>
            <button :class="{ on: mo.scope.value === 'all' }" @click="mo.setScope('all', props.workspaceKey)">
              全部项目
            </button>
          </div>
          <span v-if="workspaceName && mo.scope.value === 'project'" class="mo-ws">{{ workspaceName }}</span>
          <span class="mo-spacer" />
          <button class="mo-close" v-tooltip="'关闭'" @click="emit('close')">
            <Icon name="close" :size="13" :stroke-width="1.4" />
          </button>
        </header>

        <nav class="mo-tabs">
          <button class="mo-tab" :class="{ on: tab === 'memory' }" @click="tab = 'memory'">
            记忆<span v-if="mo.scope.value === 'project' && mo.scan.value" class="n">{{ mo.scan.value.topics.length }}</span>
            <span v-else-if="mo.scope.value === 'all' && mo.projectScans.value.length" class="n">{{ mo.projectScans.value.reduce((n, p) => n + p.scan.topics.length, 0) }}</span>
          </button>
          <button class="mo-tab" :class="{ on: tab === 'evolution' }" @click="tab = 'evolution'">演化</button>
          <button class="mo-tab" :class="{ on: tab === 'influence' }" @click="tab = 'influence'">影响</button>
        </nav>

        <div class="mo-body">
          <div v-if="mo.loading.value && !mergedScan" class="mo-state">读取记忆中…</div>
          <div v-else-if="mo.error.value" class="mo-state err">{{ mo.error.value }}</div>
          <div v-else-if="!mergedScan" class="mo-state">尚无数据</div>
          <template v-else>
            <MemoryList
              v-if="mo.scope.value === 'project'"
              v-show="tab === 'memory'"
              :scan="mo.scan.value!"
              :previews="mo.previews"
              :confirming="mo.confirming.value"
              :deleting="mo.deleting.value"
              :events="mo.events.value"
              @preview="(n) => mo.preview(props.workspaceKey, n)"
              @confirm="(n) => (mo.confirming.value = n)"
              @delete="(n) => mo.remove(props.workspaceKey, n)"
            />
            <GlobalMemoryList
              v-else
              v-show="tab === 'memory'"
              :projects="mo.projectScans.value"
              :project-names="projectNames"
              :claude-md="mo.globalClaudeMd.value"
              :deleting="mo.deleting.value"
              @delete="(k, n) => mo.removeGlobal(k, n)"
            />
            <EvolutionView v-show="tab === 'evolution'" :scan="mergedScan" :diff="mo.diff.value" :hide-diff="mo.scope.value === 'all'" />
            <InfluenceView
              v-show="tab === 'influence'"
              :scan="mergedScan"
              :events="mo.events.value"
              :session-names="mo.sessionNames.value"
              :current-session-id="props.currentSessionId"
              :reach-override="globalReach"
              :project-names="projectNames"
              :show-project="mo.scope.value === 'all'"
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
.mo-scope {
  display: inline-flex;
  border: 1px solid var(--aide-border);
  border-radius: 999px;
  overflow: hidden;
  margin-left: 6px;
}
.mo-scope button {
  border: none;
  background: transparent;
  color: var(--aide-text-muted);
  font-size: 11px;
  padding: 2px 11px;
  cursor: pointer;
}
.mo-scope button.on { background: var(--aide-surface-active); color: var(--aide-text-primary); }
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
