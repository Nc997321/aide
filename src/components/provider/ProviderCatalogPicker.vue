<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useProviderCatalog } from "@/composables/useProviderCatalog";
import { useProviders } from "@/composables/useProviders";
import ProviderLogo from "../ProviderLogo.vue";
import type { ProviderKind } from "@/types";

const emit = defineEmits<{
  (e: "select", kind: ProviderKind): void;
  (e: "select-custom"): void;
  (e: "cancel"): void;
}>();

const { catalog, loadCatalog, availablePresets } = useProviderCatalog();
const { allProviders } = useProviders();

onMounted(() => { void loadCatalog(); });

const addedKinds = computed<ProviderKind[]>(() => allProviders.value.map((p) => p.kind));
const presets = computed(() => availablePresets(addedKinds.value));
const disabledKinds = computed<Set<ProviderKind>>(() => {
  return new Set(allProviders.value.map((p) => p.kind));
});

function pick(kind: ProviderKind) {
  if (disabledKinds.value.has(kind)) return;
  emit("select", kind);
}
</script>

<template>
  <div class="picker-overlay" @click.self="emit('cancel')">
    <div class="picker-card">
      <div class="picker-title">选择供应商</div>
      <div class="grid">
        <button
          v-for="p in catalog"
          :key="p.kind"
          class="preset-card"
          :class="{ disabled: disabledKinds.has(p.kind) }"
          :disabled="disabledKinds.has(p.kind)"
          v-tooltip="disabledKinds.has(p.kind) ? '已添加（单实例）' : p.base_url || 'Anthropic 官方端点'"
          @click="pick(p.kind)"
        >
          <span class="preset-logo"><ProviderLogo :kind="p.kind" :text="p.icon" :size="24" /></span>
          <span class="preset-name">{{ p.name }}</span>
          <span class="preset-desc">{{ p.actions.length }} 项专属操作</span>
        </button>
      </div>
      <button class="custom-entry" @click="emit('select-custom')">自定义（高级）— 自填 base_url</button>
      <button class="cancel-btn" @click="emit('cancel')">取消</button>
    </div>
  </div>
</template>

<style scoped>
.picker-overlay { position: fixed; inset: 0; background: var(--aide-bg-overlay); display: flex; align-items: center; justify-content: center; z-index: 100; }
.picker-card { background: var(--aide-bg-base); border: 1px solid var(--aide-border); border-radius: var(--aide-radius-lg); padding: 20px; width: 460px; max-height: 80vh; overflow: auto; box-shadow: var(--aide-shadow-lg); }
.picker-title { font-size: 16px; font-weight: 600; color: var(--aide-text-primary); margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.preset-card { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 14px 10px; border-radius: var(--aide-radius-md); background: var(--aide-surface-default); border: 1px solid var(--aide-border); cursor: pointer; font-size: 14px; color: var(--aide-text-primary); }
.preset-card:hover:not(.disabled) { background: var(--aide-surface-hover); border-color: var(--aide-accent); }
.preset-card.disabled { opacity: 0.4; cursor: not-allowed; }
.preset-logo { display: inline-flex; align-items: center; justify-content: center; height: 28px; }
.preset-name { font-weight: 600; }
.preset-desc { font-size: 12px; color: var(--aide-text-muted); }
.custom-entry { width: 100%; margin-top: 14px; padding: 10px; border-radius: var(--aide-radius-md); background: transparent; color: var(--aide-text-secondary); border: 1px dashed var(--aide-border); cursor: pointer; font-size: 14px; }
.custom-entry:hover { color: var(--aide-text-primary); border-color: var(--aide-accent); }
.cancel-btn { width: 100%; margin-top: 10px; padding: 8px; background: transparent; color: var(--aide-text-muted); border: none; cursor: pointer; font-size: 13px; }
</style>
