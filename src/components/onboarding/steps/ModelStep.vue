<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { api } from "../../../api";
import { useProviders } from "../../../composables/useProviders";
import ThemedSelect from "../../ThemedSelect.vue";

const { systemDefaultMappings, saveSystemDefaultMappings } = useProviders();

// ThemedSelect 要 {value, label}；api.getDefaultModels 返回 ModelOption({value, displayName})——做一次映射
const options = ref<{ value: string; label: string }[]>([]);

onMounted(async () => {
  try {
    const list = (await api.getDefaultModels()) as { value: string; displayName: string }[];
    options.value = list.map((m) => ({ value: m.value, label: m.displayName }));
  } catch {
    options.value = []; // 登录前/网络失败：留空下拉，用户进设置再选
  }
});

// 当前默认模型 = systemDefaultMappings.anthropicModel；空则回退第一个可用
const current = computed(() => systemDefaultMappings.value.anthropicModel || options.value[0]?.value || "");
const currentLabel = computed(
  () => options.value.find((o) => o.value === current.value)?.label || current.value,
);

async function onChange(v: string) {
  await saveSystemDefaultMappings({ ...systemDefaultMappings.value, anthropicModel: v });
}
</script>

<template>
  <div class="eyebrow">04 / 04 · 模型</div>
  <div class="headline">用哪个模型？</div>
  <div class="support">已从你的供应商加载可用模型。默认这个就很好，随时能在设置里换。</div>
  <div class="model-row">
    <div class="model-pick">
      <span class="lbl">
        <span class="t">{{ currentLabel || "加载中…" }}</span>
        <span class="s">来自 Anthropic · 默认</span>
      </span>
      <ThemedSelect :model-value="current" :options="options" block @update:model-value="onChange" />
    </div>
    <div class="model-hint">模型来自你的供应商。在设置 → 模型里可加更多供应商、换默认模型。</div>
  </div>
</template>

<style scoped>
.eyebrow {
  font-size: 10px; color: var(--aide-accent); font-weight: 600;
  letter-spacing: .14em; text-transform: uppercase;
}
.headline {
  font-size: 24px; font-weight: 600; letter-spacing: -.015em; color: var(--aide-text-primary);
}
.support {
  font-size: 13px; color: var(--aide-text-secondary); line-height: 1.65; max-width: 440px;
}
.model-row { width: 100%; max-width: 380px; }
.model-pick {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; border-radius: var(--aide-radius-md);
  background: var(--aide-bg-deep); border: 1px solid var(--aide-border); box-shadow: var(--aide-highlight-inset);
}
.model-pick .lbl .t { font-size: 12.5px; color: var(--aide-text-primary); font-weight: 500; display: block; }
.model-pick .lbl .s { font-size: 10.5px; color: var(--aide-text-muted); margin-top: 2px; display: block; }
.model-hint { font-size: 10.5px; color: var(--aide-text-muted); margin-top: 8px; text-align: left; }
</style>