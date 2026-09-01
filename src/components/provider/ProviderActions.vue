<script setup lang="ts">
import type { ProviderConfig } from "@/types";
import ProviderActionsCpa from "./ProviderActionsCpa.vue";
import ProviderActionsAnthropic from "./ProviderActionsAnthropic.vue";
import ProviderActionsGeneric from "./ProviderActionsGeneric.vue";

defineProps<{ provider: ProviderConfig }>();
</script>

<template>
  <ProviderActionsCpa v-if="provider.kind === 'cpa_gpt'" :provider-id="provider.id" />
  <ProviderActionsAnthropic v-else-if="provider.kind === 'system_default'" :provider-id="provider.id" />
  <ProviderActionsGeneric v-else-if="provider.kind === 'ollama' || provider.kind === 'kimi' || provider.kind === 'deepseek' || provider.kind === 'zhipu'" :provider-id="provider.id" />
  <!-- Custom：无专属操作区，不渲染 -->
</template>