<script setup lang="ts">
import type { ProviderConfig } from "@/types";
import { useProviderCatalog } from "@/composables/useProviderCatalog";
import ProviderActionsCpa from "./ProviderActionsCpa.vue";
import ProviderActionsAnthropic from "./ProviderActionsAnthropic.vue";
import ProviderActionsGeneric from "./ProviderActionsGeneric.vue";

defineProps<{ provider: ProviderConfig }>();

// 能不能查用量由 catalog 的 `view_usage` 能力声明决定（它来自 Rust 的用量策略注册表），
// 前端不再硬编码 kind 列表——新增供应商只要在 Rust 注册一个策略实现即可。
const { presetForKind } = useProviderCatalog();
function canViewUsage(kind: ProviderConfig["kind"]): boolean {
  return presetForKind(kind)?.actions.includes("view_usage") ?? false;
}
</script>

<template>
  <ProviderActionsCpa v-if="provider.kind === 'cpa_gpt'" :provider-id="provider.id" />
  <ProviderActionsAnthropic v-else-if="provider.kind === 'system_default'" :provider-id="provider.id" />
  <ProviderActionsGeneric v-else-if="provider.kind === 'ollama' || provider.kind === 'kimi' || provider.kind === 'deepseek' || provider.kind === 'zhipu' || provider.kind === 'qwen' || provider.kind === 'volcengine'" :provider-id="provider.id" :kind="provider.kind" :can-view-usage="canViewUsage(provider.kind)" />
  <!-- Custom：无专属操作区，不渲染 -->
</template>
